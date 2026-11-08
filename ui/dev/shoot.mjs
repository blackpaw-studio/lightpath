import { chromium } from "@playwright/test";
const b = await chromium.launch();
for (const [name, w, h] of [["1280x720", 1280, 720], ["375x812", 375, 812]]) {
  for (const q of ["", "?install=1"]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await p.goto("http://localhost:5199/dev/hud.html" + q);
    await p.waitForTimeout(600);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    console.log(name, q, "hscroll:", overflow);
    await p.screenshot({ path: `dev/screenshots/hud-${name}${q ? "-install" : ""}.png` });
  }
}
await b.close();
