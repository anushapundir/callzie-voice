import { db, schema } from "@/lib/db";

/** A Callzie User — the `users` row behind a Clerk account (SPEC.md §5). */
export type User = typeof schema.users.$inferSelect;

/**
 * Maps a Clerk account onto its User row, creating it on first sign-in.
 *
 * Callzie has no Clerk webhook: signup is open (SPEC.md §14 rule 9) and the row
 * is provisioned lazily on the first authenticated request instead — see
 * ADR-0005. That makes this something a cold account's very first page view
 * runs, so it has to be idempotent under concurrency: two tabs opened at once
 * must not produce two rows, nor a 500 off the `clerk_id` unique index. Hence
 * one upsert keyed on that index rather than a select-then-insert, which is the
 * classic check-then-act race.
 */
export async function provisionUser(
  clerkId: string,
  email: string | null,
): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ clerkId, email })
    .onConflictDoUpdate({
      target: schema.users.clerkId,
      // The conflicting caller is the loser of a first-sign-in race, carrying
      // the same email as the winner, so this write is a no-op in practice.
      // It exists to make the statement return a row on both paths — DO NOTHING
      // returns none on conflict, leaving the loser with nothing to hand back.
      set: { email },
    })
    .returning();

  return user;
}
