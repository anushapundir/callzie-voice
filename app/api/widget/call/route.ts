import { retellClient } from "@/lib/retell/client";
import { startWidgetCall } from "@/lib/widget/start";

/*
  The Talk-to-us widget's only endpoint (issue #45).

  **This is the one route in Callzie reachable without a session**, and it
  creates Retell Calls. Everything unusual about it follows from that.

  It returns an access token and nothing else. Not the agent id, not the business
  id, not the Services, not the opening hours — nothing an attacker could use to
  reconstruct an account or to open a Call some other way. The refusal body is
  the same shape whatever went wrong, so probing it with a list of keys learns
  only "no", never "that key exists but you are on the wrong domain".

  CORS is answered explicitly and only for origins the Business listed. The
  browser enforces it, so it is not the security boundary — `authoriseWidget`
  is, and it runs on this side regardless of what any header says. What CORS buys
  is the widget working at all, since the response has to be readable from the
  host page.
*/

/** How long a browser may cache the preflight. An hour is unremarkable. */
const PREFLIGHT_MAX_AGE = "3600";

/**
 * The preflight.
 *
 * Deliberately permissive about *reflecting* the origin and deliberately useless
 * on its own: answering OPTIONS says nothing about whether a POST will be
 * accepted. Doing the allowlist check here as well would mean a database read on
 * every preflight — one per visitor per hour — to protect nothing, because the
 * POST is checked anyway and a non-browser client can skip the preflight
 * entirely.
 */
export function OPTIONS(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  const body = await request.json().catch(() => null);
  const key =
    typeof body === "object" && body !== null
      ? (body as { key?: unknown }).key
      : null;

  if (typeof key !== "string" || key === "") {
    return refuse(origin);
  }

  const result = await startWidgetCall({
    key,
    origin,
    createCall: async (params) => {
      const call = await retellClient().call.createWebCall(params);
      return { call_id: call.call_id, access_token: call.access_token };
    },
  });

  if (!result.ok) {
    /*
      Logged with the reason, never returned with it. An account whose widget
      has stopped working needs to know why; somebody working through a list of
      stolen keys must learn nothing at all.
    */
    console.warn(`[widget] declined: ${result.reason}`);
    return refuse(origin);
  }

  return Response.json(
    { access_token: result.accessToken },
    { headers: corsHeaders(origin) },
  );
}

/**
 * One refusal for every reason.
 *
 * 403 rather than 401: there is no authentication to retry with. The body says
 * nothing — no reason, no field, no hint — so an unknown key, a wrong origin, a
 * spent allowance and a disabled account are indistinguishable from outside.
 */
function refuse(origin: string | null): Response {
  return Response.json(
    { error: "not_available" },
    { status: 403, headers: corsHeaders(origin) },
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  /*
    The origin is reflected rather than `*`. Not for safety — the request is
    already authorised or refused server-side by then — but because `*` is a
    claim that any page may call this, and reflecting says what is actually
    true: this response was produced for the page that asked.
  */
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": PREFLIGHT_MAX_AGE,
    // Two different origins must never share a cached response.
    vary: "Origin",
  };
}
