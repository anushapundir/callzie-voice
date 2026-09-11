import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { ExtractionLlm } from "@/lib/extraction/llm";
import { extractCall } from "@/lib/extraction/run";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The four transcripts of SPEC.md §10, and no telephony.

  The LLM is a function this test supplies, so what is proved here is the
  pipeline around it: that a good answer lands, that a bad one is retried
  exactly once, that a second bad one fails softly with the raw output kept, and
  that none of it can reach the Appointment when it fails.

  Whether the PROMPT works on a real model is a different question and a
  different tool — scripts/try-extraction.ts. Neither substitutes for the other.
*/

const CLERK_ID = "user_test_extraction_run";
const STARTS_AT = new Date("2026-08-20T09:00:00.000Z");

let seed: ToolTestSeed;

function transcript(name: string): string {
  return readFileSync(`fixtures/transcripts/${name}.txt`, "utf8");
}

/** An LLM that answers from a list, and remembers what it was asked. */
function fakeLlm(...answers: string[]): ExtractionLlm & { prompts: string[] } {
  const prompts: string[] = [];
  const llm = async (prompt: string) => {
    prompts.push(prompt);
    const answer = answers[prompts.length - 1] ?? answers[answers.length - 1];
    return { raw: answer, stopReason: "end_turn" };
  };
  return Object.assign(llm, { prompts });
}

function answer(fields: Record<string, unknown>): string {
  return JSON.stringify({
    notes: null,
    summary: "A call happened.",
    sentiment: "neutral",
    confirmed: null,
    new_time: null,
    ...fields,
  });
}

async function setTranscript(text: string | null) {
  await db
    .update(schema.calls)
    .set({ transcript: text, status: "completed" })
    .where(eq(schema.calls.id, seed.callId));
}

async function extraction() {
  return db.query.extractions.findFirst({
    where: eq(schema.extractions.callId, seed.callId),
  });
}

async function appointment() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
  if (!row) throw new Error("fixture appointment vanished");
  return row;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(eq(schema.appointments.id, seed.appointmentId));
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("the four transcripts", () => {
  it("records a confirmation, and confirms the Appointment", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm(
      answer({
        confirmed: true,
        sentiment: "positive",
        notes: "Wants a text reminder the day before.",
        summary: "Priya confirmed her Thursday appointment.",
      }),
    );

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm }),
    ).toBe("ok");

    const row = await extraction();
    expect(row?.status).toBe("ok");
    expect(row?.confirmed).toBe(true);
    expect(row?.notes).toBe("Wants a text reminder the day before.");
    expect((await appointment()).status).toBe("confirmed");
  });

  it("records a reschedule, and flags it rather than booking it", async () => {
    await setTranscript(transcript("reschedule"));
    const llm = fakeLlm(
      answer({ new_time: "Friday morning", sentiment: "neutral" }),
    );

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm }),
    ).toBe("ok");

    expect((await extraction())?.newTime).toBe("Friday morning");
    const row = await appointment();
    expect(row.needsAttentionReason).toBe("negotiation_truncated");
    expect(row.startsAt).toEqual(STARTS_AT);
  });

  it("records a decline, and frees the Slot", async () => {
    await setTranscript(transcript("decline"));
    const llm = fakeLlm(answer({ confirmed: false, sentiment: "negative" }));

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm }),
    ).toBe("ok");

    expect((await extraction())?.confirmed).toBe(false);
    expect((await appointment()).status).toBe("declined");
  });

  it("records a voicemail from Retell, and never applies its fallback", async () => {
    await setTranscript(transcript("voicemail"));
    // A model with nothing to go on can still return something; it must not matter.
    const llm = fakeLlm(answer({ confirmed: true }));

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: true, llm }),
    ).toBe("ok");

    const row = await extraction();
    expect(row?.inVoicemail).toBe(true);
    expect(row?.summary).toBe("A call happened.");
    expect((await appointment()).status).toBe("pending");
  });
});

describe("the prompt it builds", () => {
  it("carries the transcript, the person and the appointment time", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm(answer({}));

    await extractCall({ callId: seed.callId, inVoicemail: false, llm });

    expect(llm.prompts[0]).toContain("Priya Sharma");
    expect(llm.prompts[0]).toContain("Maya calling from Tool Test Salon");
    // 09:00 UTC is 2:30 PM in Asia/Kolkata, the seed's timezone.
    expect(llm.prompts[0]).toContain("2:30 PM");
  });
});

describe("when the answer cannot be read", () => {
  it("retries exactly once, and takes the second answer", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm("Sure! Here you go:", answer({ confirmed: true }));

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm }),
    ).toBe("ok");

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("only valid JSON");
    expect((await appointment()).status).toBe("confirmed");
  });

  it("fails softly on the second failure, keeping the raw output", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm("not json", "still not json");

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm }),
    ).toBe("failed");

    const row = await extraction();
    expect(row?.status).toBe("failed");
    expect(row?.rawLlmOutput).toBe("still not json");
    expect(row?.summary).toBeNull();
  });

  it("never changes the Appointment when it failed", async () => {
    await setTranscript(transcript("decline"));
    const llm = fakeLlm("not json", "still not json");

    await extractCall({ callId: seed.callId, inVoicemail: false, llm });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBeNull();
  });

  it("treats a truncated response as malformed, on the stop reason alone", async () => {
    await setTranscript(transcript("confirm"));
    // Valid JSON so far as it goes — but the model was cut off, so it is not the
    // whole answer and must not be read as one.
    const cut = answer({ confirmed: true });
    const llm: ExtractionLlm = async () => ({ raw: cut, stopReason: "max_tokens" });

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm }),
    ).toBe("failed");
    expect((await extraction())?.status).toBe("failed");
    expect((await appointment()).status).toBe("pending");
  });
});

describe("when there is nothing to do", () => {
  it("does not call the model when the Call has no transcript", async () => {
    await setTranscript(null);
    const llm = fakeLlm(answer({}));

    expect(
      await extractCall({ callId: seed.callId, inVoicemail: null, llm }),
    ).toBe("skipped");
    expect(llm.prompts).toHaveLength(0);
    expect(await extraction()).toBeUndefined();
  });

  it("does not call the model twice for a redelivered event", async () => {
    await setTranscript(transcript("confirm"));
    const first = fakeLlm(answer({ confirmed: true }));
    await extractCall({ callId: seed.callId, inVoicemail: false, llm: first });

    const second = fakeLlm(answer({ confirmed: false }));
    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm: second }),
    ).toBe("skipped");

    expect(second.prompts).toHaveLength(0);
    expect((await appointment()).status).toBe("confirmed");
  });

  it("does nothing for a Call it cannot find", async () => {
    const llm = fakeLlm(answer({}));
    expect(
      await extractCall({
        callId: "00000000-0000-0000-0000-000000000000",
        inVoicemail: null,
        llm,
      }),
    ).toBe("skipped");
    expect(llm.prompts).toHaveLength(0);
  });
});
