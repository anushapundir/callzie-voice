"use server";

import { revalidatePath } from "next/cache";

import { requireBusiness } from "@/lib/business/require-business";
import {
  eligibleAppointmentIds,
  quotaRemaining,
} from "@/lib/calls/batch/eligible";
import { pumpBatch } from "@/lib/calls/batch/pump";
import {
  batchProgress,
  enqueueBatch,
  stopBatch,
  type BatchProgress,
} from "@/lib/calls/batch/queue";

/*
  Call All's Server Actions (issue #17).

  The three rules app/(app)/settings/actions.ts documents hold here too.
  `requireBusiness()` comes first in every one, because a Server Action is a
  POST anyone can send and rendering a button on an authenticated screen is not
  a security boundary. Nothing closes over anything. A refusal comes back as a
  value rather than a throw, because SPEC.md §11.4 wants inline persistent UI
  for anything requiring action.

  Every one is a thin wrapper on purpose: the writes live in lib/calls/batch/
  where they are tested without Clerk.
*/

export type { BatchProgress };

export type BatchPreview = {
  eligible: number;
  /** `null` means unlimited — an admin account. */
  quotaRemaining: number | null;
  phoneCallsEnabled: boolean;
};

/** What the confirmation sheet needs before it can say anything true. */
export async function batchPreviewAction(): Promise<BatchPreview> {
  const { business } = await requireBusiness();

  const [eligible, remaining] = await Promise.all([
    eligibleAppointmentIds(business.id),
    quotaRemaining(business.id),
  ]);

  return {
    eligible: eligible.length,
    // Infinity does not survive JSON, and `null` is what the summary expects.
    quotaRemaining: Number.isFinite(remaining) ? remaining : null,
    phoneCallsEnabled: business.phoneCallsEnabled,
  };
}

export type StartBatchState = {
  queued: number;
  progress: BatchProgress;
  message?: string;
};

/**
 * Queue everybody, and place the first three.
 *
 * The flag is checked here as well as inside the pump. Refusing before
 * `enqueueBatch` runs is what stops an unflagged account filling its table with
 * Queued rows that nothing will ever dial (SPEC.md §3 rule 9).
 */
export async function startBatchAction(): Promise<StartBatchState> {
  const { business } = await requireBusiness();

  if (!business.phoneCallsEnabled) {
    return {
      queued: 0,
      progress: await batchProgress(business.id),
      message: "Phone calls are off for this account.",
    };
  }

  const { queued } = await enqueueBatch({ businessId: business.id });
  await pumpBatch({ businessId: business.id });

  // The rows, the stat strip and the quota meter have all moved.
  revalidatePath("/");

  return { queued, progress: await batchProgress(business.id) };
}

/** Empty the queue. Calls already in flight are left to finish. */
export async function stopBatchAction(): Promise<BatchProgress> {
  const { business } = await requireBusiness();

  await stopBatch(business.id);
  revalidatePath("/");

  return batchProgress(business.id);
}

/**
 * One turn of the strip's 5-second tick.
 *
 * Its job is the pump: fill any slot a finished Call left. Belt and braces
 * behind the webhook, and the only thing that un-sticks a batch if a delivery
 * never arrives.
 *
 * It returns the fresh counts, but the strip does not render them — it renders
 * what the Server Component passed it and calls `router.refresh()` instead, so
 * there is one source of truth for the numbers on screen. The return is here
 * for a caller that wants them without a re-render.
 *
 * No `revalidatePath` here: the strip refreshes itself, and doing both would
 * refetch the page twice every five seconds.
 */
export async function tickBatchAction(): Promise<BatchProgress> {
  const { business } = await requireBusiness();

  await pumpBatch({ businessId: business.id });

  return batchProgress(business.id);
}
