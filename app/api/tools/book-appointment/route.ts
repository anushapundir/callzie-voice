import type { NextResponse } from "next/server";

import { bookAppointmentTool } from "@/lib/tools/book-appointment";
import { handleInboundToolRequest } from "@/lib/tools/handle";

// The one endpoint that creates an Appointment for somebody who rang in. See
// lib/tools/book-appointment.ts for the five checks it makes, and why the name
// and callback number are the first two of them (SPEC.md §14 rule 11).
export async function POST(request: Request): Promise<NextResponse> {
  return handleInboundToolRequest(request, "book_appointment", bookAppointmentTool);
}
