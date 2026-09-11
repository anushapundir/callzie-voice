# Runbook: pointing a real phone line at Maya

**What this is for.** Callzie has bought a number and is answering it. The
business already has a number, printed on its signage and its Google listing,
that people actually ring. This is how you connect the two.

**The business keeps their number.** They do not give it to Callzie and they do
not port it. They forward it. Every carrier and every desk phone system supports
call forwarding, and it is the only approach that does not ask somebody to change
a number they have had for ten years.

---

## Before you start

Three things have to be true, and the first two are checkable on screen:

1. **Answering is switched on.** Settings → Answering calls. It cannot be turned
   on without an emergency number, which is the point.
2. **A Callzie number is attached.** Settings shows it. If there is none, nothing
   below will help — provisioning comes first.
3. **Somebody at the business can change their carrier settings.** This is the
   part nobody can do for them. It usually means the account holder, and it
   usually means a phone call or a web portal login.

---

## Pick a forwarding mode

Two, and the second is the one most businesses actually want.

**Forward everything.** Their line rings Callzie, always. Simplest to set up and
simplest to explain. Right for a business with nobody on the desk — an evening
line, a solo practitioner, a place that closed the phone years ago.

**Forward on no answer.** Their desk rings four or five times first, and rolls to
Callzie only if nobody picks up. Right for anywhere with a receptionist: the
human gets first refusal on every call and Maya catches the overflow. Configured
entirely on the carrier's side — Callzie behaves identically either way and does
not need to be told which one is in use.

There is no third mode where Callzie decides. It answers whatever reaches it.

---

## The codes

Most US and Canadian carriers use these from the business's own handset. Dial the
code, then the Callzie number, then press call. A confirmation tone or a short
recorded message means it took.

| What | Code | Turn it off |
|---|---|---|
| Forward everything | `*72` + number | `*73` |
| Forward on no answer | `*71` + number | `*73` |
| Forward when busy | `*90` + number | `*91` |

**These are conventions, not a standard.** They are right often enough to try
first and wrong often enough that you must not promise them. VoIP systems —
RingCentral, 8x8, Dialpad, Google Voice, a hosted PBX — almost always ignore
these entirely and want the change made in their web console instead. If the code
does not produce a confirmation tone, stop dialling codes and go to the portal.

Mobile numbers are their own case again, and vary by carrier more than landlines
do.

---

## Prove it worked

**Do not skip this, and do not accept "I think that's done" as proof.** A
forwarding rule that silently did not apply looks exactly like one that did,
right up until a customer rings at nine at night and hears nothing.

The test is one call:

1. From a phone that is **not** the business's own line, ring the business's
   published number.
2. Maya should answer with the business's name.
3. Open Callzie → Calls. There should be a new incoming Call, from the number you
   rang from.

If Maya does not answer, work down this list in order:

- **It rang the desk instead.** Forwarding did not apply, or you set "forward on
  no answer" and did not wait long enough. Let it ring eight times.
- **It rang out or went to the old voicemail.** Forwarding is not set. Try the
  carrier's portal rather than the code.
- **Maya answered but Callzie shows no Call.** The number reaching Callzie is not
  the one recorded in Settings. Check the exact digits, including the country
  code.
- **Something answered and hung up immediately.** Most likely the account has
  spent its inbound allowance, or answering was switched off between setup and
  the test. Both are on the Settings screen.

---

## What it costs

A Callzie number is about **$2 a month**, billed whether or not it ever rings.
That is the first per-tenant cost in this product that is not covered by free
credits, which is why numbers are not handed out at signup — see issue #44.

Inbound minutes are billed on top, against the inbound allowance shown in
Settings. Forwarding itself may also cost the business money on their own
carrier's plan; that is between them and their carrier, and worth mentioning
before they set it up rather than after.

---

## Turning it off

Two separate steps, and doing only one of them is the common mistake:

1. **Remove the forwarding** at the carrier (`*73`, or the portal). Their line
   rings their desk again.
2. **Stop answering** in Callzie Settings, and release the number if they are
   done with it.

Doing only step 2 leaves their line forwarding to a Callzie number that now
declines everything — so their phone rings nowhere. Doing only step 1 leaves a
number billing $2 a month for calls that never arrive.
