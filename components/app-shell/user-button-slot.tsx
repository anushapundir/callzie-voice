import { UserButton } from "@clerk/nextjs"

/**
 * Clerk's `<UserButton>` in the topbar's account slot (SPEC.md §11.1).
 *
 * Colours, radii, type and the focus ring come from `clerkTheme` on the
 * provider. The two overrides here are size only, and they stay local rather
 * than moving into that file because `avatarBox` is a shared element key —
 * setting it globally would shrink every avatar Clerk renders, not just this
 * one. 24px is what the 56px topbar and the sidebar wordmark are built around.
 */
export function UserButtonSlot() {
  const avatarSize = "calc(var(--spacing) * 6)"

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: { width: avatarSize, height: avatarSize },
          userButtonTrigger: { borderRadius: "var(--radius-full)" },
        },
      }}
    />
  )
}
