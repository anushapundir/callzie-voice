"use server";

import { revalidatePath } from "next/cache";

import { listAppointments } from "@/lib/business/list-appointments";
import { requireBusiness } from "@/lib/business/require-business";
import { field } from "@/lib/form-field";
import { clearGoogleConnection } from "@/lib/google/connection";
import { changeBusinessType } from "@/lib/settings/business-type";
import {
  parseBusinessTypeInput,
  type BusinessTypeState,
} from "@/lib/settings/business-type-input";
import { appointmentsOutsideHours } from "@/lib/settings/hours-conflicts";
import {
  parseBusinessHoursInput,
  type HoursState,
} from "@/lib/settings/hours-input";
import { setEmergencyLine, setInboundEnabled } from "@/lib/settings/inbound";
import { rotateWidgetKey, saveWidgetOrigins } from "@/lib/settings/widget";
import type { WidgetState } from "@/lib/settings/widget-state";
import type { InboundActionState } from "@/lib/settings/inbound-state";
import { setPhoneCallsEnabled } from "@/lib/settings/phone-calls";
import { saveBusinessHours } from "@/lib/settings/save-hours";
import {
  parseServiceInput,
  type ServicesState,
} from "@/lib/settings/services-input";
import {
  addService,
  deleteService,
  updateService,
} from "@/lib/settings/services";

/**
 * Every write the Settings screen performs.
 *
 * Seven actions, one per thing a person can change. The five that report a
 * validation result are shaped for `useActionState` — so the first argument is
 * the previous state
 * (`node_modules/next/dist/docs/01-app/02-guides/forms.md`, "Validation
 * errors"). A `"use server"` module may export nothing but async functions,
 * which is why every state type and `INITIAL_*` constant lives beside its
 * validator in `lib/settings/` rather than here.
 *
 * Three rules hold across all of them, and each one is load-bearing:
 *
 * 1. **`requireBusiness()` comes first, always.** A Server Action runs as a
 *    POST against the page and is reachable by anyone who can send that POST;
 *    rendering the form on an authenticated screen is not a security boundary
 *    (Next's Server Actions guide, "Security"). It is also what supplies the
 *    `businessId` every `lib/settings` function scopes its query by — no id
 *    from `FormData` is ever trusted as an ownership claim.
 *
 * 2. **Nothing here closes over anything.** Every input arrives through
 *    `FormData` or `requireBusiness()`. This is no longer forced: since
 *    ADR-0008 the key Next uses to encrypt closed-over variables is a stable
 *    build input, so a bound argument would work. It is kept because not
 *    sending a value to the browser at all beats encrypting it on the way —
 *    every action here reads Business-scoped data, and none of it needs to make
 *    the round trip. `app/(onboarding)/onboarding/actions.ts` holds the same
 *    line for the same reason.
 *
 * 3. **A rejected write returns state; it never throws.** SPEC.md §11.4 wants
 *    inline persistent UI for anything requiring action, so a refusal is data
 *    the form renders, not an error boundary.
 *
 * The `Action` suffix is not decoration: `saveBusinessHours`, `addService` and
 * `changeBusinessType` are all names of the `lib/settings` functions these wrap,
 * and importing both into one file without distinguishing them would be a
 * shadowing accident waiting to happen.
 */

/**
 * How many Appointments are checked against newly narrowed Business Hours.
 *
 * A ceiling rather than an unbounded scan, because this runs inside a form
 * submit. It is far above the seeded five and above anything a demo account
 * reaches, so in practice it bounds nothing — but a Business with more
 * Appointments than this would be told about only the earliest of them, which
 * is why the number is generous rather than tidy.
 */
const CONFLICT_SCAN_LIMIT = 500;

export async function saveBusinessHoursAction(
  _previous: HoursState,
  formData: FormData,
): Promise<HoursState> {
  const { business } = await requireBusiness();

  const parsed = parseBusinessHoursInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors, values: parsed.values };
  }

  await saveBusinessHours(business.id, parsed.value);

  /*
    Read back *after* the write, deliberately. #5 asks Settings to save and then
    warn rather than to refuse: the hours the person asked for are already
    committed, and this is a report on what that did to existing data — not a
    precondition that could have blocked it. Loading the Appointments before the
    save would answer the same question, but it would invite someone later to
    turn the result into a rejection, which is the behaviour this issue
    explicitly rules out.
  */
  const appointments = await listAppointments(business.id, CONFLICT_SCAN_LIMIT);
  const outOfHours = appointmentsOutsideHours(
    appointments,
    parsed.value,
    business.timezone,
  );

  revalidatePath("/settings");

  return { saved: true, outOfHours };
}

export async function addServiceAction(
  _previous: ServicesState,
  formData: FormData,
): Promise<ServicesState> {
  const { business } = await requireBusiness();

  const parsed = parseServiceInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors, values: parsed.values };
  }

  const result = await addService(business.id, parsed.value);
  if (!result.ok) {
    // The database refused it — a duplicate name — so echo the submission back
    // alongside the error, exactly as a failed parse would.
    return {
      errors: result.errors,
      values: {
        name: parsed.value.name,
        durationMinutes: String(parsed.value.durationMinutes),
      },
    };
  }

  revalidateSettings();
  return { saved: true };
}

export async function updateServiceAction(
  _previous: ServicesState,
  formData: FormData,
): Promise<ServicesState> {
  const { business } = await requireBusiness();

  /*
    Read separately from `parseServiceInput`, which deliberately does not
    validate the id: whether this Service exists and belongs to this Business is
    a question only the database can answer, and `updateService` asks it before
    considering anything else. An id that is missing, malformed or someone
    else's all come back as the same "no longer exists" message, so the endpoint
    never confirms another Business's row.
  */
  const serviceId = field(formData, "id");

  const parsed = parseServiceInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors, values: { ...parsed.values, id: serviceId } };
  }

  const result = await updateService(business.id, serviceId, parsed.value);
  if (!result.ok) {
    return {
      errors: result.errors,
      values: {
        id: serviceId,
        name: parsed.value.name,
        durationMinutes: String(parsed.value.durationMinutes),
      },
    };
  }

  revalidateSettings();
  return { saved: true };
}

export async function deleteServiceAction(
  _previous: ServicesState,
  formData: FormData,
): Promise<ServicesState> {
  const { business } = await requireBusiness();

  // No `parseServiceInput` here: a removal carries no name and no duration, and
  // running them through validation would reject the submission for fields the
  // form never sent.
  const serviceId = field(formData, "id");

  const result = await deleteService(business.id, serviceId);
  if (!result.ok) {
    // Both refusals this can return — "N appointments use this service" and
    // "that would leave you with none" — are `errors.form`, and both must stay
    // on screen next to the row rather than flash past as a toast (§11.4).
    return { errors: result.errors, values: { id: serviceId } };
  }

  revalidateSettings();
  return { saved: true };
}

export async function changeBusinessTypeAction(
  _previous: BusinessTypeState,
  formData: FormData,
): Promise<BusinessTypeState> {
  const { business } = await requireBusiness();

  const parsed = parseBusinessTypeInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors };
  }

  await changeBusinessType(business.id, parsed.value);

  /*
    The whole layout, not just this route. A Business Type selects the Template
    and therefore the Retell Agent that conducts Calls (`retell_agents` is keyed
    by `business_type`), so any cached render that resolved from the old type is
    now stale. Nothing is re-seeded — see `lib/settings/business-type.ts`.
  */
  revalidatePath("/", "layout");

  return { saved: true };
}

/**
 * Forgets Callzie's copy of the Google credentials.
 *
 * Takes no state because there is nothing to report: it cannot fail on
 * validation, and it deliberately does not revoke the grant at Google's end, so
 * there is no third-party call to go wrong (see `clearGoogleConnection`). The
 * button drives its own pending state through `useFormStatus`.
 */
export async function disconnectGoogleCalendarAction(): Promise<void> {
  const { business } = await requireBusiness();

  await clearGoogleConnection(business.id);

  revalidatePath("/settings");
}

/**
 * Turns Phone Calls on or off for this account (issue #19).
 *
 * `requireBusiness()` first, as everywhere in this file. The admin check is not
 * here — it is inside `setPhoneCallsEnabled`'s WHERE clause, so this action
 * being reachable by a POST from a non-admin writes nothing rather than relying
 * on the page that rendered the form.
 *
 * Takes `FormData`, so nothing is closed over (rule 2 above). The desired state
 * travels in a hidden field rather than being inferred from the current one: a
 * form submitted twice from a stale render must land on the value it named, not
 * flip whatever it finds.
 *
 * The boolean `setPhoneCallsEnabled` returns is dropped, and rule 3 above is
 * why that is not a refusal going unreported. The only person who can see this
 * form is an admin, for whom the write always lands. A false here means the
 * form was posted by someone the section never rendered for — either a POST
 * sent without the page at all, or an admin whose `is_admin` was revoked in SQL
 * mid-session. The revalidation below answers both: the section is gated on
 * `is_admin`, so it comes back gone rather than coming back unchanged.
 */
export async function setPhoneCallsEnabledAction(
  formData: FormData,
): Promise<void> {
  const { business } = await requireBusiness();

  await setPhoneCallsEnabled(business.id, field(formData, "enabled") === "on");

  /*
    The whole layout, not this route and the Overview — the same scope, for the
    same reason, as `changeBusinessTypeAction` above.

    `phone_calls_enabled` is read in `app/(app)/layout.tsx`, which hands it to
    `LiveCallProvider` so the browser knows whether to ask for a microphone
    before starting a Call. A page-scoped revalidation does not invalidate a
    layout segment, so the shell would keep the old answer while the pages
    inside it showed the new one. This one call covers the pages too — `"/"` with
    the layout scope invalidates that layout, every layout under it and every
    page under those, so a separate `revalidatePath("/settings")` would be
    redundant rather than belt and braces.

    `startCall` re-reads the flag server-side, so a stale shell cannot route a
    Call wrongly. What it can do is waste one: the browser sets up for the wrong
    kind of Call, and the Quota is charged for something nothing joined.
  */
  revalidatePath("/", "layout");
}

/**
 * Turns inbound answering on or off (issue #43).
 *
 * Returns a message rather than throwing when it is refused, because the one
 * refusal available — no emergency number — is an ordinary thing for somebody
 * to hit on their first visit to this section, and it names what to do next.
 */
export async function setInboundEnabledAction(
  _previous: InboundActionState,
  formData: FormData,
): Promise<InboundActionState> {
  const { business } = await requireBusiness();

  const result = await setInboundEnabled(
    business.id,
    field(formData, "enabled") === "on",
  );

  if (!result.ok) {
    /*
      `not_found` is deliberately given the same words. It means the Business
      resolved for this session and then did not exist for the write, which is
      not something to explain to somebody filling in a form.
    */
    return {
      error:
        "Add an emergency number first. Maya reads it out to anyone who " +
        "describes an emergency, so inbound cannot be switched on without it.",
    };
  }

  revalidateSettings();
  return {};
}

/**
 * Sets the number Maya reads out in an emergency (SPEC.md §14 rule 10).
 *
 * Clearing it switches inbound off, inside `setEmergencyLine` — see there for
 * why leaving the flag on with no number would be worse than switching it off.
 */
export async function setEmergencyLineAction(
  _previous: InboundActionState,
  formData: FormData,
): Promise<InboundActionState> {
  const { business } = await requireBusiness();

  const result = await setEmergencyLine(
    business.id,
    field(formData, "emergency_line") ?? "",
  );

  if (!result.ok) return { error: result.error };

  revalidateSettings();
  return {};
}

/**
 * Saves the sites the Talk-to-us widget may run on (issue #45).
 *
 * An empty list switches the widget off and clears the key — see
 * `saveWidgetOrigins` for why "off" means the lookup fails rather than the check
 * after it.
 */
export async function saveWidgetOriginsAction(
  _previous: WidgetState,
  formData: FormData,
): Promise<WidgetState> {
  const { business } = await requireBusiness();

  const result = await saveWidgetOrigins(
    business.id,
    field(formData, "origins") ?? "",
  );

  if (!result.ok) return { error: result.error };

  revalidateSettings();
  return { saved: true, key: result.key };
}

/**
 * Issues a new widget key and invalidates the old one immediately.
 *
 * The answer to "our key is on a page it should not be on". No grace period and
 * no second active key — a rotation that leaves the leaked key alive for an hour
 * is not a rotation. Every site running the snippet has to be updated
 * afterwards, which is why it is a deliberate button.
 */
export async function rotateWidgetKeyAction(
  _previous: WidgetState,
  formData: FormData,
): Promise<WidgetState> {
  const { business } = await requireBusiness();

  /*
    The value named, not inferred — the same discipline
    `setPhoneCallsEnabledAction` applies to its switch. This action invalidates
    a key that is live on somebody's website, so an empty POST at this endpoint
    must do nothing rather than do that.
  */
  if (field(formData, "confirm") !== "rotate") {
    return { error: "Could not issue a new key." };
  }

  const rotated = await rotateWidgetKey(business.id);
  if (!rotated) return { error: "Could not issue a new key." };

  revalidateSettings();
  return { saved: true, key: rotated.key };
}

/**
 * Settings and Overview both, because Services are not local to this screen —
 * they name the Appointments Overview lists, and #7's quick-add reads them for
 * its picker. Hours are revalidated the same way for the same reason once #18's
 * Schedule view lands.
 */
function revalidateSettings(): void {
  revalidatePath("/settings");
  revalidatePath("/");
}
