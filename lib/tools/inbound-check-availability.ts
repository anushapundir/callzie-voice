import { offerSlots } from "@/lib/tools/check-availability";
import type { InboundToolContext } from "@/lib/tools/request";
import type { ToolHandler } from "@/lib/tools/run";
import { NOT_COMMITTED } from "@/lib/tools/say";
import { chooseService } from "@/lib/tools/service-choice";

/**
 * `check_availability`, for an inbound Call (issue #43).
 *
 * The same Tool name and the same answer shape as the outbound one — the model
 * cannot tell the difference and does not need to. The one thing that differs is
 * where the Service comes from, and that is the whole reason this file exists.
 *
 * An outbound Call is about an Appointment, and that Appointment has a Service
 * whose duration is the Slot size. An inbound caller says "I'd like a cleaning",
 * and until they do there is nothing to size a Slot with. `chooseService` falls
 * back to the Business's shortest Service, which offers the most times and books
 * the least of somebody's day — see the reasoning there.
 *
 * The Service is echoed back in the result so the model can carry it into
 * `book_appointment` rather than re-guessing, and so a support conversation
 * looking at `tool_invocations` can see which Service the offered times were
 * sized against.
 */
export const inboundCheckAvailability: ToolHandler<InboundToolContext> = async ({
  tx,
  context,
  args,
  now,
}) => {
  const service = await chooseService(tx, context.businessId, args.service_name);

  if (!service) {
    /*
      A Business with no Services at all. Onboarding seeds some, so this means
      somebody deleted every one — and there is genuinely nothing to offer.

      `succeeded: true` because this is a fact about the Business rather than a
      Tool failure, the same reasoning the outbound handler applies to a fully
      booked fortnight.
    */
    return {
      succeeded: true,
      result: { ok: true, slots: [], say: NOT_COMMITTED.nothingOpen },
    };
  }

  const outcome = await offerSlots({
    tx,
    now,
    callId: context.callId,
    businessId: context.businessId,
    serviceId: service.id,
    timezone: context.timezone,
  });

  return {
    ...outcome,
    result: {
      ...(outcome.result as Record<string, unknown>),
      // So `book_appointment` can pass back the Service these times were sized
      // for, instead of matching the caller's words a second time and possibly
      // landing somewhere else.
      service_name: service.name,
    },
  };
};
