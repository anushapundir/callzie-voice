import type { NextResponse } from "next/server";

import { handleInboundToolRequest } from "@/lib/tools/handle";
import { logEnquiryTool } from "@/lib/tools/log-enquiry";

// The Tool that makes an unanswered phone worth answering: it writes down what
// the call was about so it turns up on somebody's dashboard tomorrow. See
// lib/tools/log-enquiry.ts for why `resolved` is never Callzie's to set.
export async function POST(request: Request): Promise<NextResponse> {
  return handleInboundToolRequest(request, "log_enquiry", logEnquiryTool);
}
