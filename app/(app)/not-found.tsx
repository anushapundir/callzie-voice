import Link from "next/link"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"

/**
 * What a bad link inside the app looks like.
 *
 * Until this existed, `notFound()` — which the Call detail screen calls for any
 * id this account does not own — fell all the way through to Next's own black
 * and white error page, outside the shell, with no way back.
 */
export default function AppNotFound() {
  return (
    <EmptyState
      title="We could not find that page"
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/">Back to overview</Link>
        </Button>
      }
    >
      The link may be out of date, or whatever it pointed at has since been
      removed.
    </EmptyState>
  )
}
