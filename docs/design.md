# The design system

Everything here is enforced by `app/globals.css`. That file *is* the Tailwind
config, and it deletes Tailwind's stock palette, type scale and radius scale, so
a colour, size or radius that is not named below emits no CSS at all. If a class
does nothing, that is why.

Read this before adding a component. It is short on purpose.

## The idea in one line

A typeset broadsheet that happens to run software. Warm paper, warm ink,
hairline rules instead of boxes, numbers set like a financial report, and
exactly one colour — which only ever means "a call is live right now".

## Colour

One system, three grounds, all built from the same token names — so a component
written once works on any of them.

- **Default** is the app: warm paper, because it is a document you work in for
  an hour at a time.
- **`data-ground="bright"`** is the landing page: white, with a faint blue in
  the greys. A front door is a poster, not a document, and the cool greys are
  what make its tinted bands read as clean rather than as aged paper.
- **`data-ground="dark"`** is available for an ink band. Nothing uses it today.

| Token | Job |
| --- | --- |
| `bg` / `surface` | Paper. The only ground. Cards do not get a different white. |
| `surface-soft` | Row hover, outside-hours bands, the sign-in brand half. |
| `surface-card` | Active nav fill, pressed states, code blocks. |
| `line` | Every hairline between rows. |
| `line-strong` | The one heavier rule: under a section title, above every table. |
| `text` / `accent` | Ink. Body text and the primary button are the same colour. |
| `accent-active` | Pressed ink. A primary button hovers to this, never to 80% opacity. |
| `text-muted` | Labels, captions, secondary facts. |
| `live` | Cobalt. See the rule below. |
| `confirmed` `rescheduled` `declined` `unreachable` `attention` | Status. |

**The `live` rule.** Cobalt may appear in exactly five places: the pulsing live
dot, the in-progress status dot, the shimmer on the row being called, the
recording player's playhead, and the live favicon. It may never appear on a
link, a button, a focus ring, an icon or a chart. A screen with no live call has
almost no colour, and that is the point. Grep `-live` in review.

Status is always a 6px dot plus the word in ink. Never a filled pill, never a
bordered chip on a table row.

## Type

Three faces, each with one job.

- **Instrument Serif** (`font-serif`) is the app's display voice. It appears on
  the page title and the Call-detail verdict, and nowhere else.
- **Outfit** (`font-display`) is the wordmark and every heading on the landing
  page. Geometric with round bowls, which is what makes the front door read as
  friendly. It does not appear inside the app. Italic at most one word per screen, and never in muted grey.
- **Inter** (`font-sans`) is every other word. 400 body, 500 labels, section
  titles and buttons, 600 for the page title. Never 700.
- **JetBrains Mono** (`font-mono`) is for five data types only: phone numbers,
  clock times, durations, tool names, and JSON. Never a sentence, never an
  inline count in prose.

**Figures are Inter 500 with tabular numerals, not mono.** JetBrains Mono
slashes its zero, which makes "0 of 5 calls used" read as "Ø of 5". `body`
already sets `font-variant-numeric: tabular-nums`, so columns line up
everywhere without asking.

**Weight lives in the token.** `--text-section` is 500 and `--text-page` is 600.
Do not write `font-medium` or `font-semibold` next to `text-section` or
`text-page` — that is how the same heading ended up shipping at two weights.

Sizes: `text-table` 13 · `text-body` 14 · `text-section` 16 · `text-page` 22 ·
`text-title` 32. `text-display` and `text-display-sm` are the landing's only
extra sizes. Eyebrows and table headers are `text-table` uppercase with
`tracking-[0.06em]` in `text-muted`. There is no sixth size.

## Shape

`rounded-card` is 6px, `rounded-control` is 4px, `rounded-full` is for dots and
the avatar. Nothing else.

Four border kinds, each meaning exactly one thing:

1. `line` — a hairline between rows. Horizontal only.
2. `line-strong` — under a section title and above every table.
3. ink 1px — around the two or three objects on a screen you act *inside*
   (Quick call, the selected business-type tile).
4. `attention` 1px — the only coloured border. Needs Attention, a failed
   extraction, CSV rejections.

Paper is the only ground. **A section is a run of rows separated by hairlines,
not a box.** A box is reserved for an object with an edge you act inside. Never
a box inside a box. No shadows, except `shadow-overlay` on things that float
over the page — popovers, tooltips, drawers.

## Primitives

Use these. Do not hand-roll their chrome; that is how 22 files ended up drawing
the same card four different ways.

| Component | Use for |
| --- | --- |
| `ui/card` | The bordered objects you act inside. `tone="ink"` or `tone="attention"`. |
| `ui/pill` | Status as dot + word. `quiet` inside tables. |
| `ui/page-header` | A section title, its one-line description and its actions. |
| `ui/empty-state` | Every "nothing here yet", with or without a spinner. |
| `ui/callout` | Warnings only. Never a paragraph. |
| `ui/pending-submit-button` | Any form submit. Carries its own pending state. |
| `brand/wordmark` | The logo, everywhere. There is no other drawing of it. |

There is no `Textarea`, and there must not be one. SPEC.md §14 rule 5 says a
Business chooses one of four curated Templates and never writes Maya's prompt,
and `lib/onboarding/no-prompt-authoring.test.ts` fails the build if a textarea
appears in the onboarding flow. Every field in this product is one line long.

`ui/button` has two sizes: `default` (32px) and `sm` (28px). The rule for
variants, everywhere: committing a form is `default`; a reversible on/off is
`outline` in both directions; something irreversible is `destructive`.

## Motion

All CSS. There is no animation library.

1. **Typeset** — the landing headline sets itself line by line on entry.
2. **Chapter** — the product frame stays pinned while the chapters scroll past.
3. **Rule draw** — inline text links draw a 1px underline on hover. Nav items,
   buttons and row actions get a 150ms colour change only.
4. **Wake up** — `data-live` on the app wrapper flips the topbar dot, the row
   wash and the favicon together when Maya is on a call.

150ms on hover and state. Reduced motion collapses all of it, including delays.

## Copy

Write for the owner of a salon, not for the engineer who built this. No vendor
names outside the admin section, no capitalised domain nouns mid-sentence, no
spec citations. One sentence where two would do. Buttons are verbs in sentence
case. An error says what went wrong and what to do next.
