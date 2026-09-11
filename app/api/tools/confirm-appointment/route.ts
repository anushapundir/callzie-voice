import type { NextResponse } from "next/server";

import { confirmAppointment } from "@/lib/tools/confirm-appointment";
import { handleToolRequest } from "@/lib/tools/handle";

export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "confirm_appointment", confirmAppointment);
}
