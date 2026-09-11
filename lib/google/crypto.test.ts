import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "@/lib/google/crypto";

/*
  Pure crypto — no database, no network, no environment. Every key here is
  generated in-process and thrown away, so no test in this file can be made to
  pass or fail by a real TOKEN_ENCRYPTION_KEY, and none can leak one.

  The assertions that matter are the negative ones. Encrypt-then-decrypt working
  proves very little; what this column needs is the guarantee that a value which
  is *not* what we sealed can never come back out looking like one.
*/
const KEY = randomBytes(32).toString("base64");

/** A plausible Google refresh token — long, opaque, with URL-ish punctuation. */
const TOKEN = "1//0gL9k-Zx_example.refresh-token/AAAAAA+bb/cc==";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a refresh token", () => {
    expect(decryptSecret(encryptSecret(TOKEN, KEY), KEY)).toBe(TOKEN);
  });

  it("round-trips values the format could plausibly mangle", () => {
    for (const value of ["", "a", "unicode ✅ ünï", ":::", "v1:not:a:payload"]) {
      expect(decryptSecret(encryptSecret(value, KEY), KEY)).toBe(value);
    }
  });

  it("emits v1:<iv>:<tag>:<ciphertext> with base64url parts", () => {
    const parts = encryptSecret(TOKEN, KEY).split(":");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // base64url's alphabet — no +, / or = to be mangled by a URL or a log line.
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // 12-byte IV, 16-byte tag, unpadded base64url.
    expect(Buffer.from(parts[1], "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64url")).toHaveLength(16);
  });

  it("never repeats a ciphertext, because the IV is fresh per call", () => {
    // The one catastrophic misuse of GCM is IV reuse under a fixed key.
    const seen = new Set(
      Array.from({ length: 50 }, () => encryptSecret(TOKEN, KEY).split(":")[1]),
    );
    expect(seen.size).toBe(50);
  });

  it("rejects a flipped ciphertext byte instead of decrypting it", () => {
    const [version, iv, tag, ciphertext] = encryptSecret(TOKEN, KEY).split(":");

    const bytes = Buffer.from(ciphertext, "base64url");
    bytes[0] ^= 0x01;
    const tampered = [version, iv, tag, bytes.toString("base64url")].join(":");

    // The point of GCM over CBC: this is *detected*, not silently turned into
    // a different string.
    expect(() => decryptSecret(tampered, KEY)).toThrow(
      /authentication tag does not match/,
    );
  });

  it("rejects a flipped IV byte", () => {
    const [version, iv, tag, ciphertext] = encryptSecret(TOKEN, KEY).split(":");

    const bytes = Buffer.from(iv, "base64url");
    bytes[0] ^= 0x01;

    expect(() =>
      decryptSecret([version, bytes.toString("base64url"), tag, ciphertext].join(":"), KEY),
    ).toThrow(/authentication tag does not match/);
  });

  it("rejects a truncated tag rather than checking fewer bits", () => {
    const [version, iv, tag, ciphertext] = encryptSecret(TOKEN, KEY).split(":");
    const short = Buffer.from(tag, "base64url").subarray(0, 8).toString("base64url");

    expect(() => decryptSecret([version, iv, short, ciphertext].join(":"), KEY)).toThrow(
      /bad IV or tag length/,
    );
  });

  it("rejects a value sealed under a different key", () => {
    const other = randomBytes(32).toString("base64");

    expect(() => decryptSecret(encryptSecret(TOKEN, KEY), other)).toThrow(
      /authentication tag does not match/,
    );
  });

  it("rejects an unknown version prefix", () => {
    const sealed = encryptSecret(TOKEN, KEY).replace(/^v1:/, "v2:");

    // Forward compatibility: a row written by a newer deploy must not be fed to
    // this cipher on the assumption that the format never changed.
    expect(() => decryptSecret(sealed, KEY)).toThrow(/Unknown encrypted secret version/);
  });

  it("rejects a payload with the wrong number of parts", () => {
    expect(() => decryptSecret("v1:only:three", KEY)).toThrow(/malformed/);
    expect(() => decryptSecret("", KEY)).toThrow(/malformed/);
  });

  it("names the fix when the key is missing or the wrong length", () => {
    // An empty string rather than `undefined`, which would fall through to the
    // default and make this assertion depend on the developer's .env.local.
    expect(() => encryptSecret(TOKEN, "")).toThrow(/TOKEN_ENCRYPTION_KEY is not set/);
    expect(() => encryptSecret(TOKEN, randomBytes(16).toString("base64"))).toThrow(
      /must decode to 32 bytes, got 16/,
    );
  });

  it("tolerates a key pasted with surrounding whitespace", () => {
    // The realistic .env accident: a trailing newline inside the value.
    expect(decryptSecret(encryptSecret(TOKEN, `  ${KEY}\n`), KEY)).toBe(TOKEN);
  });

  it("never puts the plaintext or the key in an error message", () => {
    const message = (() => {
      try {
        decryptSecret(encryptSecret(TOKEN, KEY), randomBytes(32).toString("base64"));
        return "";
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    })();

    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(KEY);
  });
});
