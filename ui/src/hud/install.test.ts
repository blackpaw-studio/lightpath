// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AGENT_PAGE, installPanel, LNA_HINT, RUN_CMD, SAFARI_HINT } from "./install";

const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const panel = (ua = CHROME) => installPanel(document, ua);

describe("installPanel", () => {
  it("offers the single run command, not the install script, as the copyable command", () => {
    expect(RUN_CMD).toBe("curl -fsSL https://lightpath.blackpaw.studio/run | sh");
    const p = panel();
    expect([...p.querySelectorAll(".code-row code")].map((c) => c.textContent)).toEqual([RUN_CMD]);
    expect(p.textContent).not.toContain("1 · Install");
  });
  it("explains what the command does in one line", () => {
    expect(panel().textContent).toContain("Downloads a small helper and starts it. Ctrl-C to stop.");
  });
  it("copy button writes the run command to the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    panel().querySelector<HTMLButtonElement>("button.copy")!.click();
    expect(writeText).toHaveBeenCalledWith(RUN_CMD);
  });
  it("keeps install.sh as a small 'Install permanently' link", () => {
    const link = panel().querySelector<HTMLAnchorElement>("a.install-link")!;
    expect(link.textContent).toBe("Install permanently");
    expect(link.getAttribute("href")).toBe("/install.sh");
  });
  it("keeps the agent page link and the LNA hint", () => {
    const p = panel();
    expect(p.querySelector<HTMLAnchorElement>("a.agent-link")!.href).toBe(AGENT_PAGE);
    expect(p.querySelector(".hint")!.textContent).toBe(LNA_HINT);
  });
  it("gives Safari the Safari hint instead", () => {
    const ua = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
    expect(panel(ua).querySelector(".hint")!.textContent).toBe(SAFARI_HINT);
  });
  it("is hidden until the HUD shows it", () => {
    expect(panel().hidden).toBe(true);
  });
});
