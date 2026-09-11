import type { AppointmentStats } from "@/lib/business/appointment-stats"
import { cn } from "@/lib/utils"

/** Real appointment counts, grouped for a quick scan of the day. */
export function StatStrip({ stats }: { stats: AppointmentStats }) {
  return (
    <dl className="workspace-stats">
      <Figure label="Appointments" value={String(stats.total)} />
      <Figure label="Confirmed" value={String(stats.confirmed)} />
      <Figure label="Needs attention" value={String(stats.needsAttention)} emphasis={stats.needsAttention > 0 ? "text-attention" : undefined} />
      <Figure label="Answer rate" value={stats.answerRate === null ? "—" : `${Math.round(stats.answerRate * 100)}%`} />
    </dl>
  )
}

function Figure({ label, value, emphasis }: { label: string; value: string; emphasis?: string }) {
  return <div className="workspace-stat"><dt>{label}</dt><dd className={cn("text-text", emphasis)}>{value}</dd></div>
}
