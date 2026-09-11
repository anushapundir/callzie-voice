import { NextResponse, after } from "next/server";

import type { ToolName } from "@/lib/db/schema";
import { isAuthorised } from "@/lib/tools/auth";
import {
  parseToolRequest,
  resolveInboundToolContext,
  resolveToolContext,
  type InboundToolContext,
} from "@/lib/tools/request";
import { syncAppointmentToGoogle } from "@/lib/google/sync";
import { runTool, type ToolHandler } from "@/lib/tools/run";

/**
 * Everything the four Tool routes do before they differ.
 *
 * Here rather than duplicated four times, because the auth check is the security
 * boundary and four copies is four chances for one of them to drift.
 *
 * **The status codes.** `4xx` means this request should never have been made and
 * there is nothing for Maya to say. A business refusal is different — "that time
 * just went" is part of the conversation — so it comes back as `200` with
 * `{ ok: false, reason }` and she reads it out.
 *
 * Nothing is recorded for a 401, 400 or 404: `tool_invocations.call_id` is NOT
 * NULL with a foreign key, so a request we cannot tie to a Call has no row to
 * write. That gap is deliberate — the alternative is a nullable `call_id` that
 * every reader of the table then has to handle, for a case that only ever means
 * "someone posted garbage".
 */
/**
 * The Tools whose outcome changes what should be on the calendar.
 *
 * `book_slot` moves an Appointment and `cancel_appointment` ends one.
 * `check_availability` only offers times, and `confirm_appointment` changes a
 * status without touching `starts_at` — pushing for either would be a wasted
 * round trip on every offer Maya makes, and she makes several per Call.
 *
 * A list rather than a condition inside the loop below, so adding a fifth Tool
 * forces somebody to decide which side of this line it falls on rather than
 * silently getting no push.
 */
const CALENDAR_CHANGING_TOOLS: readonly ToolName[] = [
  "book_slot",
  "cancel_appointment",
];

export async function handleToolRequest(
  request: Request,
  name: ToolName,
  handler: ToolHandler,
): Promise<NextResponse> {
  // First, before the body is even read. An unauthenticated caller learns
  // nothing about whether their payload was well-formed.
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseToolRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const context = await resolveToolContext(parsed.callId);
  if (!context) {
    return NextResponse.json({ error: "unknown_call" }, { status: 404 });
  }

  /*
    `parsed.name` is deliberately ignored in favour of the route's own `name`.
    The route is the authority on which Tool this is; trusting the body would let
    a caller record a book_slot as a check_availability, and `tool_name` is
    exactly the field the one-booking index keys on.
  */
  const result = await runTool({ name, args: parsed.args, context, handler });

  /*
    ADR-0004's one-way push, deferred until after the response.

    `after()` runs this once the body is already on its way back to Retell, and
    that placement is the whole point: Maya is mid-conversation, and a Google
    round trip on this path is dead air the customer hears. Same mechanism and
    same reasoning as app/api/webhooks/retell/route.ts, and safe for the same
    reason — Cloud Run is deployed with `--no-cpu-throttling`.

    The ordering ADR-0004 asks for falls out of where this sits: `runTool` has
    committed its transaction by the time it returns, so Postgres is always the
    thing that decided, and Google is only ever told afterwards.
  */
  if (CALENDAR_CHANGING_TOOLS.includes(name)) {
    after(() => syncAppointmentToGoogle(context.appointment.id));
  }

  return NextResponse.json(result);
}

/**
 * The same shape, for the three inbound Tools (issue #43).
 *
 * A sibling rather than a branch inside `handleToolRequest`, because the two
 * differ in the one place that matters: which context they resolve. An outbound
 * Tool resolves an Appointment and refuses without one; an inbound Tool resolves
 * a Business and refuses an outbound Call. Folding them together would put a
 * conditional in the middle of the security boundary, and the whole reason both
 * of these are thin is so that boundary stays readable.
 *
 * No Google push. `book_appointment` creates an Appointment that ADR-0004's
 * one-way sync would happily push — but that sync resolves the Business's
 * credentials from an Appointment id, and wiring it here is work with its own
 * failure modes that issue #43 does not need. An inbound booking appears in
 * Callzie immediately and in Google on the next Reschedule, which is a stated
 * limitation rather than a silent one.
 */
export async function handleInboundToolRequest(
  request: Request,
  name: ToolName,
  handler: ToolHandler<InboundToolContext>,
): Promise<NextResponse> {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseToolRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const context = await resolveInboundToolContext(parsed.callId);
  if (!context) {
    return NextResponse.json({ error: "unknown_call" }, { status: 404 });
  }

  // The route's own `name` wins over the body's, for the reason above.
  const result = await runTool({ name, args: parsed.args, context, handler });

  return NextResponse.json(result);
}

/**
 * `check_availability`, which both Agents share (issue #43).
 *
 * One Tool name, one URL, two Agents — so unlike every other Tool endpoint this
 * one cannot know from its own route which kind of Call is on the line. It finds
 * out from the Call itself.
 *
 * Inbound is tried first because `resolveInboundToolContext` is the stricter of
 * the two: it returns null for anything that is not an inbound Call with a
 * caller number, so a false positive is not available to it. Falling through to
 * the outbound resolver then behaves exactly as it did before this ticket.
 *
 * The alternative — two URLs and two Tool names — would have meant the inbound
 * prompt calling something like `check_availability_inbound`, and every sentence
 * about offers in `docs/` having to say which one it meant.
 */
export async function handleCheckAvailabilityRequest(
  request: Request,
  inbound: ToolHandler<InboundToolContext>,
  outbound: ToolHandler,
): Promise<NextResponse> {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseToolRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const inboundContext = await resolveInboundToolContext(parsed.callId);
  if (inboundContext) {
    const result = await runTool({
      name: "check_availability",
      args: parsed.args,
      context: inboundContext,
      handler: inbound,
    });

    return NextResponse.json(result);
  }

  const context = await resolveToolContext(parsed.callId);
  if (!context) {
    return NextResponse.json({ error: "unknown_call" }, { status: 404 });
  }

  const result = await runTool({
    name: "check_availability",
    args: parsed.args,
    context,
    handler: outbound,
  });

  return NextResponse.json(result);
}
