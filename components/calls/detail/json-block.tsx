/**
 * A jsonb value, printed for a human to read.
 *
 * Used for a tool call's arguments and result, and for the write-up card's raw
 * block. `JSON.stringify` with two spaces rather than a bespoke renderer: these
 * are debugging surfaces, and the shape of the object is part of what somebody
 * reading them needs to see.
 *
 * A wash, not a border. This always sits inside something that already has an
 * edge — the ink outcome card, the amber failed-write-up card — and a box drawn
 * inside a box is the thing docs/design.md rules out by name. `surface-card` is
 * the token for a code block, and it separates the JSON from the page on its
 * own.
 *
 * `overflow-x-auto` because a timestamp is a 24-character string and the right
 * column is narrow. The page body must never scroll sideways.
 */
export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-control bg-surface-card p-3 font-mono text-table text-text-muted">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  )
}
