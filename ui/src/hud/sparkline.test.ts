// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sparkline } from "./sparkline";

describe("sparkline", () => {
  it("draws one point per hop with a mean RTT and skips timeouts", () => {
    const svg = sparkline(document, [
      [{ ip: "a", rttMs: 10 }], [{ ip: null, rttMs: null }], [{ ip: "c", rttMs: 30 }, { ip: "c", rttMs: 50 }],
    ]);
    expect(svg.querySelectorAll("circle")).toHaveLength(2);
    expect(svg.querySelector("polyline")).not.toBeNull();
  });
  it("renders nothing drawable for no data", () => {
    expect(sparkline(document, []).querySelectorAll("circle")).toHaveLength(0);
  });
});
