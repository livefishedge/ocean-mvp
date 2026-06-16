// Quick diagnostic loader — find out what the page actually shows
const { chromium } = require("playwright");

const URL = process.env.SMOKE_URL || "https://livefishedge.github.io/view/?region=usec_south&var=thermal_fronts";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => logs.push(`[pageerror] ${err.message}\n${err.stack || ""}`));
  page.on("requestfailed", req => logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText || ""}`));

  console.log("loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000); // generous wait for first paint + init

  const state = await page.evaluate(() => {
    const body = document.body;
    return {
      bodyClasses: body.className,
      hasThermalControls: !!document.getElementById("thermal-front-controls"),
      thermalControlsHTML: (document.getElementById("thermal-front-controls")?.outerHTML || "").slice(0, 400),
      chipPanelExists: !!document.getElementById("thermal-day-chips-panel"),
      allDayCbExists: !!document.getElementById("thermal-all-day-cb"),
      allDayCbChecked: document.getElementById("thermal-all-day-cb")?.checked,
      modeDailyBtnExists: !!document.getElementById("thermal-mode-daily"),
      modeHourlyBtnExists: !!document.getElementById("thermal-mode-hourly"),
      modeHourlyActive: document.getElementById("thermal-mode-hourly")?.classList.contains("active"),
      modeDailyActive: document.getElementById("thermal-mode-daily")?.classList.contains("active"),
      varSelectValue: document.getElementById("var-select")?.value,
      hasVarSelect: !!document.getElementById("var-select"),
      buildFp: window.__VIEW_BUILD_THERMAL || null,
      pageTitle: document.title,
      buildTagInHTML: (document.documentElement.outerHTML.match(/dashboard-v2-2026-06-13T[0-9:]+/) || ["none"])[0]
    };
  });
  console.log("STATE:", JSON.stringify(state, null, 2));
  console.log("LOGS (last 30):");
  for (const l of logs.slice(-30)) console.log("  ", l);

  await browser.close();
})();
