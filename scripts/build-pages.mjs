// Turns ui/*.html into convex/*Page.ts string constants, so the pages can be edited as plain
// HTML (no template-literal escaping) and still ship inside the Convex deployment.
// Run: npm run build:pages   Check (CI): npm run build:pages -- --check
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = [{ src: "ui/admin.html", out: "convex/adminPage.ts", name: "ADMIN_HTML" }];
const check = process.argv.includes("--check");
let stale = 0;
for (const p of PAGES) {
  const html = readFileSync(p.src, "utf8");
  const ts = `// Generated from ${p.src} by scripts/build-pages.mjs. Edit the HTML, then run npm run build:pages.\nexport const ${p.name} = ${JSON.stringify(html)};\n`;
  let cur = "";
  try { cur = readFileSync(p.out, "utf8"); } catch {}
  if (cur === ts) continue;
  if (check) { console.error(`${p.out} is out of date: run npm run build:pages`); stale++; }
  else { writeFileSync(p.out, ts); console.log(`wrote ${p.out}`); }
}
process.exit(stale ? 1 : 0);
