import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { CallHistory } from "@/components/calls/call-history"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { requireBusiness } from "@/lib/business/require-business"
import { formatDuration } from "@/lib/calls/duration"
import { listCalls } from "@/lib/calls/list"
import { formatInZone } from "@/lib/time/zone"

export default async function CallsPage() {
  const { business } = await requireBusiness()
  const calls = await listCalls(business.id)

  return (
    <div className="flex flex-col gap-8">
      <div className="workspace-intro">
        <div><p className="workspace-eyebrow">EVERY CONVERSATION, REMEMBERED</p><h2>Here’s how it went.</h2><p>Find a call, listen back, and see what Maya took care of. Call times are shown in {business.timezone}.</p></div>
        <Button asChild><Link href="/#quick-call">Start a call <ArrowUpRight size={16} aria-hidden /></Link></Button>
      </div>
      {calls.length === 0 ? (
        <EmptyState title="Your first conversation starts here." action={<Button asChild><Link href="/#quick-call">Make your first call</Link></Button>}>
          Start a call with Maya. The recording, transcript, and outcome will be waiting here afterwards.
        </EmptyState>
      ) : (
        <CallHistory calls={calls.map((call) => ({
          id: call.id,
          personName: call.personName,
          serviceName: call.serviceName,
          status: call.status,
          attempt: call.attempt,
          duration: formatDuration(call.durationSeconds),
          calledAt: call.createdAt ? formatInZone(call.createdAt, call.timezone) : "Time unavailable",
        }))} />
      )}
    </div>
  )
}
