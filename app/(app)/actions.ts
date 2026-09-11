"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
import { resolveEnquiry } from "@/lib/business/open-enquiries";
import { createAppointment } from "@/lib/appointments/create";
import {
  MAX_CSV_ROWS,
  type CsvRow,
  type CsvUploadState,
} from "@/lib/appointments/csv-input";
import { uploadCsvRows } from "@/lib/appointments/csv-upload";
import {
  parseQuickAddInput,
  type QuickAddState,
} from "@/lib/appointments/quick-add-input";
import { findAvailableSlots } from "@/lib/availability/find";
import { requireBusiness } from "@/lib/business/require-business";
import { recheckCollisions } from "@/lib/google/recheck";
import { syncAppointmentToGoogle } from "@/lib/google/sync";
import { field } from "@/lib/form-field";
import { formatInZone } from "@/lib/time/zone";

/**
 * Overview's Server Actions — the quick-add write, the Slot list the card
 * re-reads when the Service changes, and the CSV upload.
 *
 * The three rules `app/(app)/settings/actions.ts` documents hold here too:
 * `requireBusiness()` comes first always, because a Server Action is a POST
 * reachable by anyone who can send it and rendering the card on an
 * authenticated screen is not a security boundary; nothing closes over
 * anything; and a rejected write returns state rather than throwing, because
 * SPEC.md §11.4 wants inline persistent UI for anything requiring action.
 */

/**
 * How far ahead the Slot picker looks, and how many options it will render.
 *
 * Fourteen days so a Business open two days a week still has something to
 * offer. Fifty options because past that a `<select>` stops being usable — a
 * presentation bound, not a correctness one, and the list is truncated from the
 * far end so the soonest Slots always survive.
 */
const HORIZON_DAYS = 14;
const MAX_SLOT_OPTIONS = 50;

const DAY_MS = 86_400_000;

/**
 * The messages behind `createAppointment`'s three refusals.
 *
 * `slot_taken` is worded for the race it describes. The picker only ever offers
 * open Slots, so the ordinary way to reach it is someone else booking the same
 * Slot between the page rendering and this submit.
 */
const REFUSALS: Record<"not_offered" | "in_the_past" | "slot_taken", string> = {
  not_offered: "That is not a time you can book. Pick one from the list.",
  in_the_past: "That time has already passed.",
  slot_taken: "Someone just booked that time. Pick another.",
};

/** One entry in the time picker. `value` is an ISO instant; `label` is local. */
export type SlotOption = { value: string; label: string };

export async function addAppointmentAction(
  _previous: QuickAddState,
  formData: FormData,
): Promise<QuickAddState> {
  const { business } = await requireBusiness();

  const parsed = parseQuickAddInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors, values: parsed.values };
  }

  /*
    The submission, echoed back so a rejected submit repopulates rather than
    clearing. The phone is the string the person typed, not the E.164 it
    normalises to: showing them `+447700900123` after a refusal that had nothing
    to do with their number would look like the form had rewritten it.
  */
  const submitted = {
    name: parsed.value.name,
    phone: field(formData, "phone"),
    serviceId: parsed.value.serviceId,
    startsAt: parsed.value.startsAt.toISOString(),
  };

  let result;
  try {
    result = await createAppointment({
      businessId: business.id,
      serviceId: parsed.value.serviceId,
      name: parsed.value.name,
      phoneE164: parsed.value.phoneE164,
      startsAt: parsed.value.startsAt,
    });
  } catch {
    /*
      `loadSchedule` throws when the Service id does not resolve for this
      Business. Reachable without doing anything strange: delete a Service in a
      Settings tab while Overview is open in another, and the card is still
      offering it.

      Caught here because SPEC.md §11.4 wants inline persistent UI for anything
      requiring action, and letting this through would show the one thing #7's
      acceptance criteria rule out — a generic error with no reason in it. This
      is what `errors.form` exists for: nothing the person typed is wrong, so
      there is no field to hang it on.
    */
    return {
      errors: { form: "That service no longer exists. Pick another." },
      values: submitted,
    };
  }

  if (!result.ok) {
    // Every refusal lands on the time field, because the time is the only thing
    // the person can change to fix any of them.
    return { errors: { startsAt: REFUSALS[result.reason] }, values: submitted };
  }

  const newId = result.appointment.id;

  /*
    This one line is the whole of "appears in the table without a manual
    refresh". Next re-runs the page's Server Component once the action resolves,
    so the table and the stat strip come back fresh in the same round trip —
    there is no client-side cache to reconcile and nothing to poll.

    It does **not** refresh the Slot picker. That list lives in the card's own
    React state, which survives a re-render, so the card refetches it itself
    once the Appointment lands. See `components/overview/quick-call-card.tsx`.
  */
  revalidatePath("/");

  /*
    ADR-0004's one-way push, after the response rather than before it. Postgres
    has already committed, so the Appointment is real whatever Google does next,
    and the person watching the card does not wait on a third party to see their
    booking appear.
  */
  after(() => syncAppointmentToGoogle(newId));

  return {
    added: {
      id: result.appointment.id,
      name: result.appointment.name,
      startsAt: formatInZone(result.appointment.startsAt, business.timezone),
    },
  };
}

/**
 * The open Slots for one Service, for the time picker.
 *
 * A read rather than a write, and an action rather than data loaded with the
 * page, because Slot size is the Service duration: one Service's Slots cannot
 * be reused for another. Settings lets a Business add Services without limit, so
 * pre-computing all of them would make page load cost grow with the Service
 * count. One Availability run per page load and one per Service change does not.
 */
export async function slotOptionsAction(
  serviceId: string,
): Promise<SlotOption[]> {
  const { business } = await requireBusiness();

  const now = new Date();
  const slots = await findAvailableSlots({
    businessId: business.id,
    // Scoped inside `loadSchedule`: a Service id belonging to another Business
    // does not resolve, so this throws rather than reading someone else's
    // Availability.
    serviceId,
    from: now,
    to: new Date(now.getTime() + HORIZON_DAYS * DAY_MS),
    now,
  });

  return slots.slice(0, MAX_SLOT_OPTIONS).map((slot) => ({
    value: slot.startsAt.toISOString(),
    label: formatInZone(slot.startsAt, business.timezone),
  }));
}

/**
 * Create Appointments from an uploaded CSV (issue #8).
 *
 * The browser parses the file — SPEC.md §2 puts PapaParse client-side — and
 * sends the rows here. **None of the browser's checks are trusted.** A Server
 * Action is a POST reachable by anyone who can send it, so the array shape and
 * the row cap are settled again on this side, and every field is validated here
 * regardless of what the client concluded. The client's copies of those checks
 * exist to save a round trip, nothing more.
 *
 * Two kinds of failure, two places to render them. A problem with the file as a
 * whole — empty, oversized — has no row to hang it on, so it comes back as
 * `file_error` and renders inside the upload sheet. Everything per-row travels
 * in the report and renders in the persistent panel on the page, because
 * SPEC.md §11.4 wants inline persistent UI for anything requiring action and a
 * rejected row is the definition of that.
 */
export async function uploadCsvAction(rows: unknown): Promise<CsvUploadState> {
  const { business } = await requireBusiness();

  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: "file_error", message: "That file is empty." };
  }

  if (rows.length > MAX_CSV_ROWS) {
    return {
      status: "file_error",
      message:
        `That file has ${rows.length} rows. ` +
        `Upload at most ${MAX_CSV_ROWS} at a time.`,
    };
  }

  /*
    Coerced rather than assumed. Anything that is not a string becomes an empty
    one, which `parseCsvRow` already has a message for — so a malformed payload
    comes back as a readable per-row report instead of a 500.

    `rowNumber` is a display label and carries no authority, but it is still
    checked: a forged one could only ever mislabel the sender's own report, and
    falling back to the position in the array keeps the panel honest.
  */
  const clean: CsvRow[] = rows.map((row, index) => {
    const raw = (row ?? {}) as Partial<Record<keyof CsvRow, unknown>>;
    const rowNumber =
      typeof raw.rowNumber === "number" &&
      Number.isInteger(raw.rowNumber) &&
      raw.rowNumber > 0
        ? raw.rowNumber
        : index + 2; // the header is line 1
    return {
      rowNumber,
      name: text(raw.name),
      phone: text(raw.phone),
      service: text(raw.service),
      time: text(raw.time),
    };
  });

  const report = await uploadCsvRows({
    businessId: business.id,
    timezone: business.timezone,
    rows: clean,
  });

  // The same one line as the quick-add write: Next re-runs the page's Server
  // Component once this resolves, so the table and the stat strip come back
  // fresh in the same round trip with nothing to poll.
  revalidatePath("/");

  /*
    One `after()` for the whole file, looping the rows in order rather than one
    deferred task per row. A fifty-row upload should not open fifty concurrent
    connections to Google, and each sync is cheap.
  */
  after(async () => {
    for (const id of report.createdIds) {
      await syncAppointmentToGoogle(id);
    }
  });

  return { status: "done", report };
}

/**
 * A human has dealt with an Appointment Callzie stopped calling (issue #15).
 *
 * The same three-line shape as every other action in this file:
 * `requireBusiness()` first — a Server Action is a POST reachable by anyone who
 * can send it, and rendering a button on an authenticated screen is not a
 * security boundary — then delegate, then revalidate.
 *
 * The Business id comes from the session and is passed separately, so the only
 * thing the browser supplies is which Appointment. An id belonging to another
 * account matches nothing inside `clearNeedsAttention`'s WHERE clause.
 *
 * That one `revalidatePath` re-renders the whole Overview tree in the same
 * round trip: the panel loses the row and the stat strip's Needs attention
 * count drops. Nothing polls, and there is no client cache to reconcile.
 *
 * It flips the row's "Call now" button back on too. The table disables that
 * from `needsAttentionReason` on the row it already holds, so the same
 * re-render that drops the panel row re-enables the button — no second
 * mechanism, nothing to keep in step.
 *
 * The server still refuses independently, in `lib/calls/start-web-call.ts`.
 * The button is a courtesy; that check is the rule.
 *
 * Returns nothing, and that is a real limitation rather than a design win.
 *
 * A wrong id plumbed through here writes nothing and says nothing; what catches
 * that is the revalidate, because the row stays in the panel — the bug showing
 * itself on the screen the person is already looking at. But a database that is
 * simply unreachable is worse: `useTransition` does not surface a rejection
 * thrown after its first `await`, so the spinner stops, the button says "Clear"
 * again, and nobody is told. An expired session is fine — Next turns the
 * `redirect()` thrown by `requireBusiness()` into a navigation to sign-in.
 *
 * Every other void action in this app has the same hole
 * (`app/(app)/calls/actions.ts`, `app/(app)/settings/actions.ts`), so this is
 * not a new one. Worth fixing across all of them rather than here alone, and
 * worth naming because this is the only documented way out of Needs Attention.
 */
export async function clearAttentionAction(
  appointmentId: string,
): Promise<void> {
  const { business } = await requireBusiness();

  await clearNeedsAttention(business.id, appointmentId);

  revalidatePath("/");
  /*
    Schedule reads the same column to mark a Collision in its day grid, so
    clearing one from Overview would leave `/schedule` showing it until
    something else re-rendered that page.

    `lib/appointments/clear-attention.ts` predicted this exact staleness and
    noted it could not happen yet, because nothing wrote `collision`. #20 is
    what made it possible, so #20 is what closes it.
  */
  revalidatePath("/schedule");
}

/**
 * Marks an Enquiry dealt with (issue #43).
 *
 * The inbound sibling of `clearAttentionAction` above, and deliberately a
 * separate action rather than a widened one. That one unblocks Callzie — it says
 * "you may call this person again". This says "a human has done the thing the
 * caller was waiting for". They look alike on screen; they are not the same
 * write and must not become one.
 *
 * `resolveEnquiry` scopes the write to the Business inside its own statement, so
 * the boolean it returns is dropped for the same reason
 * `setPhoneCallsEnabledAction` drops its own: a false means the request came
 * from somebody the panel never rendered for, and the revalidation answers that
 * by bringing the panel back without the row.
 *
 * Only `/` is revalidated. Unlike a Needs Attention reason, nothing on
 * `/schedule` reads `enquiries.resolved` — an Enquiry has no Slot in the day
 * grid, and one that booked is already an ordinary Appointment there.
 */
export async function resolveEnquiryAction(enquiryId: string): Promise<void> {
  const { business } = await requireBusiness();

  await resolveEnquiry(business.id, enquiryId);

  revalidatePath("/");
}

/**
 * Look at the connected Google Calendar again, and raise a Collision for
 * anything new sitting in an upcoming Appointment's window.
 *
 * ADR-0004's push-time read only sees what was already there when Callzie
 * booked. The case that actually happens — the owner adds a conflicting event
 * an hour later — has nothing to trigger a push, so this runs when somebody
 * opens Overview.
 *
 * **It revalidates only when something was written**, and that condition is
 * load-bearing rather than an optimisation. The client island calls this on
 * mount; an unconditional `revalidatePath` would re-render the tree, and a
 * re-render that remounted the island would call it again. Because a cleared
 * Collision is never re-raised (`lib/google/collision.ts`), a second run finds
 * nothing new, returns zero, and the loop cannot start.
 *
 * Silent on every failure. `recheckCollisions` swallows its own Google errors,
 * and there is nothing here for a person to act on — ADR-0004 requires Callzie
 * to keep working for a Business with no calendar at all.
 */
export async function recheckCollisionsAction(): Promise<void> {
  const { business } = await requireBusiness();

  const raised = await recheckCollisions(business.id);
  if (raised === 0) return;

  revalidatePath("/");
  revalidatePath("/schedule");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
