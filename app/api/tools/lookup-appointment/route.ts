import type { NextResponse } from "next/server";

import { handleInboundToolRequest } from "@/lib/tools/handle";
import { lookupAppointmentTool } from "@/lib/tools/lookup-appointment";

// Matches on the number the caller is ringing from and on nothing else. See
// lib/tools/lookup-appointment.ts for why accepting a name would read a
// stranger's booking out loud.
export async function POST(request: Request): Promise<NextResponse> {
  return handleInboundToolRequest(
    request,
    "lookup_appointment",
    lookupAppointmentTool,
  );
}
