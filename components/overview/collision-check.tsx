"use client"

import { useEffect, useRef } from "react"

import { recheckCollisionsAction } from "@/app/(app)/actions"

/**
 * Asks the server to look at Google Calendar again, once, when Overview loads.
 *
 * **Why a client component on a screen made of Server Components.** ADR-0004's
 * push-time read only catches an event that was already on the calendar when
 * Callzie booked. The case the acceptance criterion actually describes — the
 * owner opens Google and adds a conflicting event afterwards — has nothing to
 * trigger a push, so something has to look again. Without a cron, "when the
 * owner is looking" is the moment that costs nothing and misses least.
 *
 * **Here and not on Schedule.** Schedule is deliberately a pure Server
 * Component with no client JavaScript at all, and #18's design says to cut that
 * screen if interaction starts creeping into it. Overview already ships client
 * components, so this adds a pattern rather than breaking one.
 *
 * Renders nothing. It is a side effect with a place in the tree, not UI — the
 * Collisions it raises appear in the Needs Attention panel #15 already built.
 *
 * **The loop this cannot start.** The action revalidates only when it actually
 * wrote something, and a cleared Collision is never re-raised, so a second run
 * finds nothing and returns without revalidating. If it revalidated
 * unconditionally, a remount would call it again forever.
 *
 * The `ref` guards React's development-mode double-invoke of effects, which
 * would otherwise send two identical requests to Google on every page load.
 */
export function CollisionCheck() {
  const asked = useRef(false)

  useEffect(() => {
    if (asked.current) return
    asked.current = true

    /*
      Deliberately unawaited and deliberately silent. Nothing on this screen
      waits for Google, and there is nothing for a person to do about a failed
      check — ADR-0004 requires Callzie to work fully for a Business with no
      calendar, which is the same position as one whose calendar is unreachable
      right now. `recheckCollisions` already logs on the server.
    */
    void recheckCollisionsAction().catch(() => {})
  }, [])

  return null
}
