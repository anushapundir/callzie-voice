"use client"

import { Loader2 } from "lucide-react"
import { useFormStatus } from "react-dom"

import { Button } from "@/components/ui/button"

/**
 * A submit button that reports its own form's in-flight state.
 *
 * Exists so a **Server Component** can still meet SPEC.md §11.4's "every async
 * action has a loading state on its own button". `useFormStatus` is a client
 * hook, and it reports on the nearest `<form>` *above* the component that calls
 * it — so a server-rendered section that submits to a Server Action has no way
 * to show pending state without a client child exactly this size. Making the
 * whole section a client component instead would be the wrong trade: sections
 * like the Google one read server-only modules, and the button is the only part
 * that needs interactivity.
 *
 * Use this for every form submit, client or server. Four files used to carry
 * their own copy, and the four drifted to three different sizes.
 */
export function PendingSubmitButton({
  label,
  pendingLabel,
  variant = "default",
  disabled = false,
}: {
  label: string
  pendingLabel: string
  variant?: "default" | "outline" | "ghost" | "destructive"
  /**
   * Disabled for a reason of the caller's own, on top of `pending`.
   *
   * Added for the inbound switch (issue #43), which cannot work until an
   * emergency number is saved. The action refuses in that case anyway — this is
   * so the button looks like what it is rather than failing when pressed.
   */
  disabled?: boolean
}) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant={variant} disabled={pending || disabled}>
      {/* On the button itself; §11.4 rules out a full-page blocker. */}
      {pending && <Loader2 className="animate-spin" aria-hidden />}
      {pending ? pendingLabel : label}
    </Button>
  )
}
