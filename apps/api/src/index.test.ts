import { describe, expect, it } from "vitest";
import { ping } from "@app/shared";
import { buildApp } from "./index.js";

describe("api entrypoint", () => {
  it("builds a Fastify instance with no routes registered", () => {
    const app = buildApp();
    expect(app).toBeDefined();
  });

  it("can import @app/shared via the workspace protocol", () => {
    expect(ping()).toBe("pong");
  });
});
