import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

/**
 * Authenticated encryption for the one column SPEC.md §5 marks "encrypted at
 * rest" — `businesses.google_refresh_token`. ADR-0009 is the decision; this is
 * its implementation, and the alternatives it rejects (pgcrypto, CMEK,
 * plaintext) are argued there rather than repeated here.
 *
 * A Google refresh token is not a session artefact. It is a long-lived bearer
 * credential that grants write access to somebody's real calendar until they
 * revoke it, and unlike an API key it belongs to a *user*, not to us. A database
 * dump, a leaked backup or an over-broad `db:studio` session must not hand
 * whoever holds it the ability to write events into every connected Business's
 * calendar. Encrypting the column moves the blast radius from "the database" to
 * "the database plus a secret that only ever exists in Secret Manager and the
 * running process".
 *
 * **AES-256-GCM, not AES-256-CBC.** GCM authenticates as well as encrypts, so a
 * modified ciphertext is *detected* rather than decrypted into plausible
 * rubbish. That distinction is the whole point here: a silently corrupted
 * refresh token would surface much later as an inexplicable Google API failure
 * on a Business that believes it is connected.
 *
 * Hand-rolled on Node's `crypto` rather than pulled from a package, matching the
 * house pattern — `lib/time/zone.ts` does its own timezone maths and
 * `lib/onboarding/input.ts` its own validation. There is nothing here a
 * dependency would do better; the primitives are in the standard library.
 */

const VERSION = "v1";

/**
 * 96 bits, the size GCM is specified for. Longer or shorter IVs are legal in
 * Node but get hashed down internally, which loses the guarantee that two
 * distinct random IVs stay distinct.
 */
const IV_BYTES = 12;

/** GCM's full-length authentication tag. Truncating it weakens the guarantee. */
const TAG_BYTES = 16;

/** AES-256. `TOKEN_ENCRYPTION_KEY` is 32 random bytes, base64-encoded. */
const KEY_BYTES = 32;

/**
 * The raw key, with the two ways of getting it wrong turned into loud errors.
 *
 * A base64 string of the wrong length is the realistic mistake — someone
 * generates 16 bytes, or pastes a key with a newline in it. Node would either
 * throw an opaque "Invalid key length" from deep inside `createCipheriv`, or,
 * worse, a *different* key silently produces ciphertext nothing can read back.
 * Both messages below name the fix.
 */
function keyFrom(keyBase64: string | undefined): Buffer {
  if (!keyBase64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with " +
        "`openssl rand -base64 32` and add it to .env.local.",
    );
  }

  const key = Buffer.from(keyBase64.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    // Never echo the value — this message reaches logs.
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }

  return key;
}

/**
 * `plaintext` sealed as `"v1:<iv>:<tag>:<ciphertext>"`, each part base64url.
 *
 * **The version prefix is not decoration.** `TOKEN_ENCRYPTION_KEY` will
 * eventually have to be rotated — on a leak, or simply on principle — and a
 * rotation means rows encrypted under the old key and rows encrypted under the
 * new one coexisting in the same column for as long as the migration takes.
 * Without a discriminator in the stored value there is no way to tell them
 * apart, so the only rotation available is "disconnect every Business and make
 * them re-authorise". With one, a future `v2:` can carry a key id (or a new
 * cipher) and `decryptSecret` can dispatch on it while `v1:` rows keep working.
 * The cost of reserving it now is four bytes (ADR-0009).
 *
 * **A fresh random IV per call**, never a counter and never a constant. Reusing
 * an IV under the same key is the one catastrophic misuse of GCM: it leaks the
 * XOR of the two plaintexts and, worse, the authentication subkey, which lets an
 * attacker forge tags. 96 random bits per encryption is the standard answer, and
 * this column sees a handful of writes per Business per lifetime.
 *
 * base64url rather than base64 so the value survives any URL, header or log line
 * it is ever pasted into without an encoding layer disagreeing about `+` and `/`.
 * `:` is the separator precisely because base64url's alphabet excludes it.
 */
export function encryptSecret(
  plaintext: string,
  keyBase64: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
): string {
  const key = keyFrom(keyBase64);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  // Only readable after `final()` — GCM computes the tag over the whole message.
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/**
 * The plaintext behind `payload`, or a thrown error. Never a partial answer.
 *
 * Every failure below is a *throw*, deliberately, and none of them returns a
 * best-effort string. A wrong key, a truncated column, a value written by a
 * future version, a byte flipped in transit — all of them mean "this is not the
 * refresh token you stored", and the only safe response is to stop. Returning
 * garbage would send a corrupted credential to Google and surface as an
 * authentication error attributed to the user's Google account rather than to
 * Callzie's storage.
 *
 * The GCM tag check inside `final()` is what makes that possible: it is a
 * cryptographic verification that the ciphertext is exactly what was sealed, so
 * "decrypted successfully" and "decrypted correctly" are the same statement.
 *
 * Callers are expected to treat a throw as "this Business's Google connection is
 * broken, ask them to reconnect" — see `lib/google/connection.ts`.
 */
export function decryptSecret(
  payload: string,
  keyBase64: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
): string {
  const parts = payload.split(":");
  if (parts.length !== 4) {
    throw new Error(
      "Encrypted secret is malformed: expected 'v1:<iv>:<tag>:<ciphertext>'.",
    );
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts;
  if (version !== VERSION) {
    // The forward-compatibility half of the version prefix. A row written by a
    // newer deploy must fail loudly on an older one rather than be fed to the
    // wrong cipher.
    throw new Error(
      `Unknown encrypted secret version "${version}". This value was written by ` +
        "a different version of lib/google/crypto.ts.",
    );
  }

  const key = keyFrom(keyBase64);
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");

  // Checked here rather than left to Node: base64url decoding is lenient, so a
  // mangled part yields a short buffer, and `setAuthTag` accepts several lengths
  // without complaint. A short tag is a weakened check, which is exactly the
  // failure this function exists to prevent.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Encrypted secret is malformed: bad IV or tag length.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      // Throws "Unsupported state or unable to authenticate data" when the tag
      // does not match. Re-thrown below with a message that says what it means.
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // The original error is swallowed on purpose: it carries no information a
    // reader needs, and this path must never risk logging key or ciphertext
    // material.
    throw new Error(
      "Failed to decrypt secret: the authentication tag does not match. The " +
        "value was tampered with, truncated, or encrypted under a different " +
        "TOKEN_ENCRYPTION_KEY.",
    );
  }
}
