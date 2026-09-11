/**
 * The message under an input that a field-level validation error produces.
 *
 * Lived in `components/settings/section.tsx` until Overview's quick-add card
 * needed the same seven lines. Overview should not import from settings, and a
 * second copy would be a second place for the colour to drift, so it moved
 * here. `SettingsSection` and `SettingsCallout` stayed — those are genuinely
 * settings-shaped.
 *
 * Renders nothing when there is no message, so a caller can pass a possibly
 * undefined error without guarding first.
 */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-table text-declined">
      {message}
    </p>
  )
}
