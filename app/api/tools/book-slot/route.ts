import type { NextResponse } from "next/server";

import { bookSlotTool } from "@/lib/tools/book-slot";
import { handleToolRequest } from "@/lib/tools/handle";

// The one endpoint that commits a Reschedule. See lib/tools/book-slot.ts for the
// four checks it makes and why none of them may be dropped.
export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "book_slot", bookSlotTool);
}
