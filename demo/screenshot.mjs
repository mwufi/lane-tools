// node demo/screenshot.mjs <outDir> <pingpalHtml> <laneConvexUrl>
// Screenshots the lanes index, both lane pages and pingpal running against a lane.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const [outDir, appHtml, convexUrl] = process.argv.slice(2);
const base = process.env.LANE_URL;
const tok = "#token=" + process.env.LANE_TOKEN;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const shots = [
  ["lanes-index.png", `${base}/${tok}`],
  ["lane-feat-reactions.png", `${base}/lane?repo=demo%2Fpingpal&branch=feat%2Freactions${tok}`],
  ["lane-feat-nudges.png", `${base}/lane?repo=demo%2Fpingpal&branch=feat%2Fnudges${tok}`],
];
for (const [name, url] of shots) {
  await page.goto(url);
  await page.waitForSelector("h1");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
}
const app = await browser.newPage({ viewport: { width: 900, height: 640 }, deviceScaleFactor: 2 });
await app.goto(`file://${appHtml}?convex=${encodeURIComponent(convexUrl)}&me=ada&with=bo`);
await app.waitForSelector(".m", { timeout: 20000 });
await app.fill("#text", "sent from a lane 🛣️");
await app.click("form button");
await app.waitForTimeout(2000);
await app.screenshot({ path: `${outDir}/pingpal-on-lane.png` });
await browser.close();
console.log("screenshots in " + outDir);
