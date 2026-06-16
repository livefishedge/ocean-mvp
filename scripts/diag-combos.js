// Try the URL without var= to see if that works
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", msg => logs.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`));
  page.on("pageerror", err => logs.push(`[pageerror] ${err.message}`));

  const urls = [
    "https://livefishedge.github.io/view/",
    "https://livefishedge.github.io/view/?region=usec_south",
    "https://livefishedge.github.io/view/?region=usec_south&var=thermal_fronts",
  ];
  for (const u of urls) {
    console.log(`\n=== ${u} ===`);
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const state = await page.evaluate(() => ({
      title: document.title,
      bodyClasses: document.body.className,
      hasControls: !!document.getElementById("thermal-front-controls"),
      hasPlot: !!document.getElementById("plot"),
      varSelectValue: document.getElementById("var-select")?.value,
      buildFp: window.__VIEW_BUILD_THERMAL || null,
      buildTagInHTML: (document.documentElement.outerHTML.match(/dashboard-v2-2026-06-13T[0-9:]+/) || ["none"])[0]
    }));
    console.log(JSON.stringify(state, null, 2));
  }
  console.log("\nLOGS (last 10):");
  for (const l of logs.slice(-10)) console.log("  ", l);

  await browser.close();
})();
