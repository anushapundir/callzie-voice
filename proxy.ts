import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { SIGN_IN_URL, SIGN_UP_URL } from "@/lib/auth/routes";

/*
  Next 16 renamed Middleware to Proxy — same runtime, same position in the
  request path, different filename. Clerk's `clerkMiddleware()` returns a
  standard `(request, event)` handler, so it drops straight into the new
  convention (node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md).

  This file is what makes every app route private, and it is the security gate —
  not the layout that calls `requireUser()`. The default is "signed in": routes
  are listed here to be made *public*, so a screen added later is protected by
  omission rather than by remembering to protect it.
*/
const isPublicRoute = createRouteMatcher([
  `${SIGN_IN_URL}(.*)`,
  `${SIGN_UP_URL}(.*)`,
  // The marketing landing page. Signed-out visitors to `/` are rewritten here
  // (see the handler below), and the page itself must be reachable without a
  // session or the rewrite would bounce straight back to sign-in.
  "/landing",
  // Retell posts here with its own signature (SPEC.md §9, docs/verification.md
  // A8). Listed ahead of the route existing because a session cookie is the
  // wrong gate for a machine caller: leaving it protected would 302 every
  // webhook to the sign-in page, which reads as a silent delivery failure.
  "/api/webhooks(.*)",
  /*
    The four Tool endpoints. Retell posts here mid-call with the internal secret
    in a header (lib/tools/auth.ts).

    "Public" means only that a Clerk session cookie is not the gate. The secret
    is — and it is the stricter of the two, because Callzie is open signup
    (SPEC.md §14 rule 9), so a cookie would let any account that exists write to
    any Appointment.

    Left protected, Clerk would 302 every Tool call to the sign-in page. Maya
    would experience a Tool that simply never works, with nothing in the logs
    saying "auth".
  */
  "/api/tools(.*)",
  /*
    The Talk-to-us widget (issue #45).

    Genuinely public, unlike the two above — there is no session cookie and no
    shared secret, because this runs on a stranger's browser on somebody else's
    domain. What stands in for both is `lib/widget/authorise.ts`: a per-Business
    key, an origin allowlist that makes a stolen key useless anywhere but the
    Business's own site, and two caps that hold if a thief is on the allowlist.

    This is the only route in the product where "public" means what it sounds
    like, and it is the one to read carefully in a review.
  */
  "/api/widget(.*)",
  // The embed script itself, served to any page that includes it.
  "/widget.js",
]);

export default clerkMiddleware(
  async (auth, request) => {
    /*
      The front door forks on the session. A signed-out visitor to `/` gets the
      marketing landing page; a signed-in one falls through to the dashboard.
      A rewrite, not a redirect: the visitor's URL stays `/`, so the site has
      one front-door address rather than a `/landing` that leaks into shared
      links and bookmarks.
    */
    if (request.nextUrl.pathname === "/") {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.rewrite(new URL("/landing", request.url));
      }
    }

    if (isPublicRoute(request)) return;

    // Sends signed-out visitors to /sign-in with a redirect back to where they
    // were headed, rather than dropping them on the root.
    await auth.protect();
  },
  // Without these the redirect goes to Clerk's hosted Account Portal instead of
  // the themed screen in app/(auth) — see lib/auth/routes.ts.
  { signInUrl: SIGN_IN_URL, signUpUrl: SIGN_UP_URL },
);

export const config = {
  matcher: [
    // Everything except Next's internals and static files, unless a static
    // filename appears in a query string (Clerk's recommended matcher).
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|mp4|webm|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run on API routes.
    "/(api|trpc)(.*)",
  ],
};
