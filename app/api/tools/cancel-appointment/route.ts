import type { NextResponse } from "next/server";

import { cancelAppointment } from "@/lib/tools/cancel-appointment";
import { handleToolRequest } from "@/lib/tools/handle";

export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "cancel_appointment", cancelAppointment);
}
