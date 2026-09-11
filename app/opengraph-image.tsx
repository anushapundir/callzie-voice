import { ImageResponse } from "next/og";

/*
  The picture that shows up when someone pastes a Callzie link into a chat.
  Next finds this file by name, renders it once at build time, and fills in the
  image URL and dimensions on the `openGraph` and `twitter` metadata in
  app/layout.tsx.

  This runs in a tiny renderer that only understands flexbox and the fonts you
  hand it, so the markup here is deliberately plain — no Tailwind classes, no
  CSS file, and every colour written out.
*/
export const alt = "Callzie";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#141311";
const PAPER = "#FAFAF7";
const MUTED = "#A8A49B";

/*
  The display face has to be fetched as an actual font file — the renderer has
  no access to the browser's font stack. If the fetch fails (offline build,
  Google unreachable) we render in the built-in face rather than failing the
  build over a social card.
*/
async function loadInstrumentSerif(): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(
      "https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    ).then((r) => r.text());
    const url = css.match(/src: url\((https:[^)]+)\)/)?.[1];
    if (!url) return null;
    return await fetch(url).then((r) => r.arrayBuffer());
  } catch {
    return null;
  }
}

export default async function Image() {
  const serif = await loadInstrumentSerif();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          padding: "80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              background: "#5B7CFF",
            }}
          />
          <div
            style={{
              color: MUTED,
              fontSize: 24,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Maya is on the line
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          <div
            style={{
              color: PAPER,
              fontSize: 92,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              maxWidth: 900,
              ...(serif ? { fontFamily: "Instrument Serif" } : {}),
            }}
          >
            The calls you keep meaning to make, made.
          </div>
          <div style={{ color: MUTED, fontSize: 30 }}>
            Maya rings your customers, settles the time, and writes it into the
            day.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            color: PAPER,
            fontSize: 56,
            ...(serif ? { fontFamily: "Instrument Serif" } : {}),
          }}
        >
          Callzie.
        </div>
      </div>
    ),
    {
      ...size,
      ...(serif
        ? {
            fonts: [
              {
                name: "Instrument Serif",
                data: serif,
                style: "normal" as const,
                weight: 400 as const,
              },
            ],
          }
        : {}),
    }
  );
}
