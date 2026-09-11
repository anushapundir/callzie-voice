import { Pill } from "@/components/ui/pill"
import { CALL_STATUS_STYLES } from "@/lib/calls/status-style"
import type { CallStatus } from "@/lib/db/schema"

/** A Call's status, as the shared `ui/pill` plus this screen's words. */
export function CallStatusPill({
  status,
  quiet = false,
}: {
  status: CallStatus
  quiet?: boolean
}) {
  const style = CALL_STATUS_STYLES[status]
  return (
    <Pill dot={style.background} quiet={quiet}>
      {style.label}
    </Pill>
  )
}
