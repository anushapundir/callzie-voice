/**
 * Seconds as `mm:ss`, for every mono time on the Call detail screen.
 *
 * Both halves are padded, always. The player's readout, the transcript's turn
 * stamps, the header's duration and the Calls list all render in mono and stack
 * into a column, so one unpadded `1:5` misaligns the lot.
 *
 * Minutes are not carried into hours. A Call is capped at 180 seconds by
 * `max_call_duration_ms` (SPEC.md §7), so an hours field would be a column that
 * is always `00:` — and `61:01` is the honest rendering of a recording that
 * somehow ran long.
 *
 * Null is an em-dash rather than `00:00`, because "Retell has not told us the
 * duration yet" and "the Call lasted no time at all" are different facts and
 * the screen shows both.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return "—";
  }

  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;

  return `${pad(minutes)}:${pad(rest)}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
