import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  These cover the production build, not the database. `next build` imports every
  route module to collect page data, and the image carries no DATABASE_URL —
  server secrets arrive from Secret Manager at boot (cloudbuild.yaml). Importing
  this module must therefore survive a missing variable; only using it may not.
*/
describe("lib/db without DATABASE_URL", () => {
  const original = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env.DATABASE_URL = original;
    vi.resetModules();
  });

  it("imports without connecting", async () => {
    await expect(import("./index")).resolves.toHaveProperty("db");
  });

  it("still exposes the schema, which needs no connection", async () => {
    const { schema } = await import("./index");
    expect(schema.businesses).toBeDefined();
  });

  it("throws on first use rather than silently returning nothing", async () => {
    const { db } = await import("./index");
    expect(() => db.select()).toThrow("DATABASE_URL is not set");
  });
});
