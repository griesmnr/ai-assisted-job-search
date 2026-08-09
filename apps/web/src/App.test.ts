import { describe, expect, it } from "vitest";
import { ping } from "@app/shared";

describe("web app", () => {
  it("can import @app/shared via the workspace protocol", () => {
    expect(ping()).toBe("pong");
  });
});
