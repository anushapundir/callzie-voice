import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { EnquiryKind } from "@/lib/db/schema";

/**
 * The Enquiries a human has to deal with (issue #43).
 *
 * The inbound half of the Needs Attention surface. `listNeedsAttention` next
 * door reads Appointments carrying a reason; this reads Enquiries nobody has
 * cleared. They are deliberately two queries returning two shapes rather than
 * one union, because they are two different things:
 *
 * - a Needs Attention row is an Appointment Callzie **will not act on again**
 *   until somebody clears it;
 * - an open Enquiry is a person who rang and **is waiting to hear back**.
 *
 * Both belong on the same part of the screen, because both mean "a human has to
 * do something". Neither is a state of the other, and forcing them into one row
 * type would mean inventing a `needs_attention_reason` for a caller who has no
 * Appointment to hang one off — the thing `lib/db/schema.ts` explicitly refuses.
 *
 * No cap, for the same reason `listNeedsAttention` has none: truncating the list
 * that exists to show you what is outstanding would hide exactly what it is for.
 * Bounded in practice by `inbound_quota`, which is the point of that column.
 *
 * Ordered newest first, unlike its neighbour. An Appointment sorts by when it
 * happens because a Slot going past is the urgent case; an Enquiry sorts by when
 * it arrived because somebody has been waiting since then.
 */

export type OpenEnquiryRow = {
  id: string;
  callId: string;
  kind: EnquiryKind;
  callerName: string | null;
  callerPhoneE164: string | null;
  topic: string | null;
  createdAt: Date | null;
};

export async function listOpenEnquiries(
  businessId: string,
): Promise<OpenEnquiryRow[]> {
  return db
    .select({
      id: schema.enquiries.id,
      callId: schema.enquiries.callId,
      kind: schema.enquiries.kind,
      callerName: schema.enquiries.callerName,
      callerPhoneE164: schema.enquiries.callerPhoneE164,
      topic: schema.enquiries.topic,
      createdAt: schema.enquiries.createdAt,
    })
    .from(schema.enquiries)
    /*
      Scoped through `calls`, which is the only edge an Enquiry has to a
      Business. `enquiries` carries no `business_id` of its own on purpose —
      `calls.business_id` is NOT NULL and one source of that fact is better than
      two that can disagree.
    */
    .innerJoin(schema.calls, eq(schema.enquiries.callId, schema.calls.id))
    .where(
      and(
        eq(schema.calls.businessId, businessId),
        eq(schema.enquiries.resolved, false),
      ),
    )
    .orderBy(desc(schema.enquiries.createdAt));
}

/**
 * Marks an Enquiry dealt with.
 *
 * Scoped to the Business in the statement rather than checked above it — the
 * same discipline as every other cross-tenant guard in `lib/`. A Server Action
 * is a POST anybody can send, so an id from another account has to match zero
 * rows rather than be caught by an `if`.
 *
 * There is no un-resolve. Callzie never resolves an Enquiry itself (CONTEXT.md),
 * and a human who clears one by mistake can read the Call detail screen, which
 * keeps everything — the transcript, the Tool invocations and the Enquiry
 * itself. Nothing is destroyed by clearing; it only stops asking.
 */
export async function resolveEnquiry(
  businessId: string,
  enquiryId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.enquiries)
    .set({ resolved: true })
    .where(
      and(
        eq(schema.enquiries.id, enquiryId),
        /*
          The tenant check, as a subquery on the Call this Enquiry belongs to.
          `enquiries` has no `business_id` to compare directly, and an UPDATE
          cannot join — so the ownership question is asked here, inside the same
          statement that writes.
        */
        eq(
          schema.enquiries.callId,
          db
            .select({ id: schema.calls.id })
            .from(schema.calls)
            .where(
              and(
                eq(schema.calls.id, schema.enquiries.callId),
                eq(schema.calls.businessId, businessId),
              ),
            ),
        ),
      ),
    )
    .returning({ id: schema.enquiries.id });

  return rows.length > 0;
}
