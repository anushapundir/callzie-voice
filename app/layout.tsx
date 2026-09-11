import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono, Outfit } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SIGN_IN_URL, SIGN_UP_URL } from "@/lib/auth/routes";
import { clerkLocalization, clerkTheme } from "@/lib/clerk-theme";
import "./globals.css";
import "./workspace.css";

// docs/design.md: Inter for all UI; JetBrains Mono for phone numbers, clock
// times, durations, tool names and JSON; Instrument Serif for the app's page
// titles and the Call verdict; Outfit for the wordmark and the landing page.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

/*
  The display face. Geometric, round bowls, friendly without being childish —
  it is what makes the landing page read as soft rather than severe, and it
  carries the wordmark everywhere. Three weights, because a geometric sans does
  its work through weight rather than through italics or small caps.
*/
const outfit = Outfit({
  variable: "--font-outfit",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

const DESCRIPTION =
  "Maya calls your customers, confirms the time, and writes it into the day.";

export const metadata: Metadata = {
  /*
    Where a relative image URL is resolved from. Without it Next builds the
    share-card URL against `http://localhost:3000`, so a link pasted into a chat
    points the preview at the reader's own machine and shows nothing.

    `APP_URL` is the deployed Cloud Run URL and is meant to stay that way even
    while you work locally (CLAUDE.md) — it is what Retell calls back on. The
    localhost fallback is only for a checkout that has no env file at all.
  */
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: "Callzie",
  description: DESCRIPTION,
  /*
    Without these a link to Callzie shares as a blank card with the bare URL.
    `opengraph-image.tsx` next to this file draws the picture; Next finds it by
    filename and fills in the image URL, width, height and type here.
  */
  openGraph: {
    title: "Callzie",
    description: DESCRIPTION,
    siteName: "Callzie",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Callzie",
    description: DESCRIPTION,
  },
};

/*
  The browser chrome follows the page. Without this the address bar flips from
  the landing's ink to the default white the moment someone presses Get
  started, which reads as two different products.
*/
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf7" },
    { media: "(prefers-color-scheme: dark)", color: "#141311" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable} ${outfit.variable} h-full`}
    >
      <body className="min-h-full">
        {/*
          The URL props come from lib/auth/routes.ts, which is also what the
          proxy reads — the client and the server have to agree or the two
          disagree about where sign-in lives. `fallback` redirects apply only
          when no `redirect_url` is present, so a visitor bounced off a deep
          link still lands back on it after signing in.
        */}
        <ClerkProvider
          appearance={clerkTheme}
          localization={clerkLocalization}
          signInUrl={SIGN_IN_URL}
          signUpUrl={SIGN_UP_URL}
          signInFallbackRedirectUrl="/"
          signUpFallbackRedirectUrl="/"
          afterSignOutUrl={SIGN_IN_URL}
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
