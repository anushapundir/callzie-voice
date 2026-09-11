import type { NextResponse } from "next/server";

import { checkAvailability } from "@/lib/tools/check-availability";
import { handleCheckAvailabilityRequest } from "@/lib/tools/handle";
import { inboundCheckAvailability } from "@/lib/tools/inbound-check-availability";

/*
  The only Tool endpoint both Agents share (issue #43).

  Same name, same answer shape, two ways of deciding which Service sizes the
  Slots: an outbound Call reads it off the Appointment, an inbound one has to
  match what the caller said. `handleCheckAvailabilityRequest` resolves the Call
  and picks — the model never knows there were two.
*/
export async function POST(request: Request): Promise<NextResponse> {
  return handleCheckAvailabilityRequest(
    request,
    inboundCheckAvailability,
    checkAvailability,
  );
}
