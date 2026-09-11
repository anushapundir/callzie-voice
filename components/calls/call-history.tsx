"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, Search } from "lucide-react"
import { CallStatusPill } from "@/components/calls/call-status-pill"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import type { CallStatus } from "@/lib/db/schema"

export type CallHistoryItem = {
  id: string
  personName: string
  serviceName: string
  status: CallStatus
  attempt: number
  duration: string
  calledAt: string
}

const FILTERS = [
  { value: "all", label: "All calls" },
  { value: "completed", label: "Completed" },
  { value: "active", label: "In progress" },
  { value: "unconnected", label: "Not connected" },
] as const

type Filter = typeof FILTERS[number]["value"]

export function CallHistory({ calls }: { calls: CallHistoryItem[] }) {
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const search = query.trim().toLocaleLowerCase()
  const visible = calls.filter((call) => {
    const matchesSearch = `${call.personName} ${call.serviceName}`.toLocaleLowerCase().includes(search)
    const matchesFilter = filter === "all" ||
      (filter === "completed" && call.status === "completed") ||
      (filter === "active" && ["queued", "ringing", "in_progress"].includes(call.status)) ||
      (filter === "unconnected" && ["failed", "no_answer"].includes(call.status))
    return matchesSearch && matchesFilter
  })

  return (
    <section className="workspace-table" aria-label="Call history">
      <div className="workspace-call-toolbar">
        <div className="workspace-search"><Search size={16} aria-hidden /><Input ref={searchRef} type="search" aria-label="Search calls by name or service" placeholder="Find a name or service…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="workspace-call-filters" role="group" aria-label="Filter calls by outcome">
          {FILTERS.map((item) => <button type="button" key={item.value} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
        </div>
      </div>
      {visible.length ? (
        <ul>
          {visible.map((call) => (
            <li key={call.id}>
              <Link className="workspace-call-row" href={`/calls/${call.id}`}>
                <span className="workspace-call-person"><span className="workspace-call-initial" aria-hidden>{call.personName.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="min-w-0"><strong>{call.personName}</strong><small>{call.serviceName}{call.attempt > 1 ? ` · Attempt ${call.attempt}` : ""}</small></span></span>
                <CallStatusPill status={call.status} />
                <span className="text-table text-text-muted"><span className="sr-only">Duration: </span>{call.duration}</span>
                <span className="workspace-call-time"><span className="sr-only">Called: </span>{call.calledAt}</span>
                <ArrowUpRight size={16} aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="No calls match that." action={<Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); searchRef.current?.focus() }}>Clear filters</Button>}>Try another name, service, or outcome.</EmptyState>}
      <p className="workspace-call-count" role="status">Showing {visible.length} of {calls.length} calls</p>
    </section>
  )
}
