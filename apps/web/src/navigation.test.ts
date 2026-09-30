// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadCurrent, reloadTo } from "./navigation";

/**
 * Ticket a90095b, opus review finding 3. Everything else in the repo mocks
 * this module wholesale (`vi.mock("../navigation")`), so until this file
 * existed NOTHING asserted what these two functions actually do -- and the
 * single line the whole "Continue to your results" fix rests on had zero
 * coverage. The reviewer demonstrated the hole with a mutation that passes
 * all 1588 other tests:
 *
 *     export function reloadCurrent(): void {
 *       window.location.replace(window.location.href);
 *     }
 *
 * That is precisely the dead-button shape the ticket exists to remove, and a
 * plausible "simplification" for a future reader staring at two nearly
 * identical one-liners.
 *
 * WHAT THIS CAN AND CANNOT PROVE. jsdom implements no navigation, so no test
 * here can show that a document really reloads. What it CAN show is which
 * browser API each function calls, which is exactly where the bug lived --
 * `replace` to the current URL instead of `reload`. An earlier attempt used
 * `vi.spyOn(window.location, "reload")` and failed ("Cannot redefine
 * property: reload"); redefining `window.location` wholesale does work, so
 * that is what these tests do, restoring the real object afterwards.
 */
const realLocation = window.location;

let replaceCalls: string[];
let reloadCalls: number;

beforeEach(() => {
  replaceCalls = [];
  reloadCalls = 0;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: "http://localhost:3000/#landOnScoredTab=1",
      replace: (url: string) => replaceCalls.push(url),
      reload: () => {
        reloadCalls += 1;
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
  vi.restoreAllMocks();
});

describe("reloadCurrent (ticket a90095b)", () => {
  it("reloads rather than replacing, so it works on the URL the page is already on", () => {
    reloadCurrent();

    expect(reloadCalls).toBe(1);
    // THE REGRESSION GUARD: a `replace` here -- even to the identical href --
    // is a same-document fragment navigation and does nothing. That is the
    // bug Nicole hit as a dead "Continue to your results" button.
    expect(replaceCalls).toEqual([]);
  });
});

describe("reloadTo (ticket a90095b)", () => {
  it("replaces when the target really is somewhere else", () => {
    reloadTo("http://localhost:3000/");

    expect(replaceCalls).toEqual(["http://localhost:3000/"]);
    expect(reloadCalls).toBe(0);
  });

  /**
   * Review finding 1 (reachable today) and finding 2 (latent). Both reduce to
   * the same shape: the failure path's `replaceState` is conditional on an
   * adjudicated refusal, so a non-adjudicated throw (a malformed `userId`
   * from a 200 response) leaves the URL already equal to
   * `urlWithoutToken()` -- and `urlWithoutToken` deliberately preserves any
   * other fragment param, so the same collision reappears the moment anyone
   * adds one. Without this guard, "Continue without signing in" was as dead
   * as the button this ticket was filed about.
   */
  it("falls back to a reload when the target is the URL already loaded", () => {
    reloadTo(window.location.href);

    expect(reloadCalls).toBe(1);
    expect(replaceCalls).toEqual([]);
  });
});
