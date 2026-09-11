import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * The names of every font size in `app/globals.css`.
 *
 * They have to be listed, and the reason is a real bug rather than tidiness.
 *
 * `tailwind-merge`'s whole job is to drop the losing class when two conflict —
 * `px-2 px-4` becomes `px-4`. To do that it has to know which group a class
 * belongs to, and it works that out from Tailwind's *default* scale. This app
 * deleted that scale (`--text-*: initial`) and named its own sizes, so
 * `text-title` is a name the library has never heard of. Faced with an unknown
 * `text-…`, it guesses "colour" — and then `text-text`, a real colour, looks
 * like a conflict and wins.
 *
 * The effect was silent and everywhere: `cn("text-title font-medium
 * text-text")` returned `font-medium text-text`. Every heading written as a
 * size *and* a colour in one `cn()` call rendered at the inherited size, so the
 * Overview's four figures shipped at 14px instead of 32px and nobody saw an
 * error, because the class simply was not in the output.
 *
 * Keep this list in step with the `--text-*` tokens in app/globals.css. If a
 * size ever renders at the wrong size for no visible reason, this is the file.
 */
const FONT_SIZES = [
  "table",
  "body",
  "section",
  "page",
  "title",
  "display",
  "display-sm",
  "lead",
] as const

/**
 * The radii, for the same reason.
 *
 * Less damaging than the sizes — two unknown `rounded-…` classes both survive,
 * and the one that wins is whichever the stylesheet happens to emit last, which
 * is arbitrary rather than what the component asked for. Naming them makes the
 * last one written win, which is what every caller expects.
 */
const RADII = ["card", "control", "soft", "chip", "full"] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
      rounded: [{ rounded: [...RADII] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
