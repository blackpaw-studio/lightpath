import { expect, test } from "@playwright/test";
import { FIXTURES } from "./agents";
import { expectClearOfPanels, expectFacingAndSafe, expectShot, openApp, poseIds, startTrace, state, step, stepLive, waitForDone } from "./harness";

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
      // Origin plus five hops, all on screen and fully bloomed in: poses and the dots actually drawn (g:).
      expect(poseIds(last)).toEqual(["0", "1", "2", "3", "4", "5"]);
      for (const id of poseIds(last)) {
        expect(last.entities[id]!.visible, `pose ${id} visible`).toBe(true);
        expect(last.entities[`g:${id}`]?.visible, `marker g:${id} drawn`).toBe(true);
      }
      await expectShot(page, `globe-done-${viewport.width}.png`);
    });

    test("no node is ever drawn behind a HUD panel, during or after the trace", async ({ page }) => {
      await openApp(page, FIXTURES.basic);
      await startTrace(page);
      const frames = await stepLive(page, SETTLE_MS);
      expectClearOfPanels(frames);
      await expectFacingAndSafe(page, frames[frames.length - 1]!);
    });
  });
}
