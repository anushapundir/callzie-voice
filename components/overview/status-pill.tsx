import { Pill } from "@/components/ui/pill"
import { STATUS_STYLES } from "@/lib/appointments/status-style"
import type { AppointmentStatus } from "@/lib/db/schema"

/**
 * An Appointment's status, as the shared `ui/pill` plus this screen's words.
 *
 * The colours live in `lib/appointments/status-style.ts`, shared with the
 * Schedule day view's blocks — see that file for why `pending` and `cancelled`
 * render the way they do.
 */
export function StatusPill({
  status,
  quiet = false,
}: {
  status: AppointmentStatus
  /** The table form: dot and word, no border. */
  quiet?: boolean
}) {
  const style = STATUS_STYLES[status]
  return (
    <Pill dot={style.background} quiet={quiet}>
      {style.label}
    </Pill>
  )
}
