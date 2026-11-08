import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import { expectShot, openApp, startTrace, state, step, waitForDone } from "./harness";

const SETTLE_MS = 6000; // bloom-in, arc pulses and camera framing all finish well inside this

for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("globe shows every hop after a full replayed trace", async ({ page }) => {
      await openApp(page, FIXTURES.basic);
      await startTrace(page);
      await waitForDone(page);
      const frames = await step(page, SETTLE_MS, true);
      const s = await state(page);
      expect(s).toMatchObject({ status: "done", reached: true, target: "example.com" });
      expect(s.hops.map((h) => h.ttl)).toEqual([1, 2, 3, 4, 5]);
      const last = frames[frames.length - 1]!;
      // Origin plus five hops, all on screen and fully bloomed in.
      expect(Object.keys(last.entities).sort()).toEqual(["0", "1", "2", "3", "4", "5"]);
      for (const [id, e] of Object.entries(last.entities)) expect(e.visible, `entity ${id} visible`).toBe(true);
      await expectShot(page, `globe-done-${viewport.width}.png`);
    });
  });
}
