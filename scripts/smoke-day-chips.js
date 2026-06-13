// Smoke test for the v4.1 day-chip multi-select feature.
// Mike, 2026-06-13 11:55 ET: verify the new chip panel is wired up
// correctly end-to-end before commit.
//
// Runs against the local livefishedge Pages URL (or override with
// SMOKE_URL env var). Asserts:
//   1. Daily mode + "All days this period" reveals the chip panel
//   2. All 14 (or N) days are listed as chips
//   3. Each chip has a non-empty rainbow swatch color
//   4. "Last 3" preset reduces count to 3
//   5. "All" preset restores all
//   6. Toggling a chip directly mutates the count
//   7. Build fingerprint has dayChipMultiSelect: true
//
// Screenshots are saved to /tmp/smoke-day-chips-*.png for visual review.
const { chromium } = require("playwright");

const URL = process.env.SMOKE_URL || "https://livefishedge.github.io/view/?region=usec_south&var=thermal_fronts";
const OUT = process.env.SMOKE_OUT || "/tmp";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => logs.push(`[pageerror] ${err.message}`));

  console.log("loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait for the thermal-fronts controls to mount.
  await page.waitForSelector("#thermal-front-controls", { timeout: 30000 });
  // The mode is daily by default? Check.
  await page.waitForSelector("#thermal-day-chips-panel", { timeout: 15000 });

  // 1) Panel initially hidden (mode is animation/hourly by default)
  const initialHidden = await page.$eval("#thermal-day-chips-panel", el => el.classList.contains("hidden"));
  console.log("chip panel hidden at load:", initialHidden);

  // Switch to Daily mode
  await page.click("#thermal-mode-daily");
  await page.waitForTimeout(500);

  // 2) Panel still hidden (all-days cb is off by default)
  const dailyModeHidden = await page.$eval("#thermal-day-chips-panel", el => el.classList.contains("hidden"));
  console.log("chip panel hidden in daily mode (all-days off):", dailyModeHidden);

  // Turn on "All days this period"
  await page.check("#thermal-all-day-cb");
  await page.waitForTimeout(800);

  // 3) Panel now visible
  const visibleNow = !(await page.$eval("#thermal-day-chips-panel", el => el.classList.contains("hidden")));
  console.log("chip panel visible after all-days on:", visibleNow);
  if (!visibleNow) throw new Error("chip panel did not reveal after all-days on");

  // 4) Wait for chips to be built
  await page.waitForFunction(() => document.querySelectorAll("#thermal-day-chips .day-chip").length > 0, { timeout: 15000 });

  // Count chips and read count text
  const initial = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#thermal-day-chips .day-chip"));
    return {
      count: chips.length,
      selected: chips.filter(c => c.classList.contains("selected")).length,
      unselected: chips.filter(c => c.classList.contains("unselected")).length,
      countText: document.getElementById("thermal-day-chips-count")?.textContent,
      swatchColors: chips.map(c => {
        const sw = c.querySelector(".day-chip-swatch");
        return sw ? getComputedStyle(sw).backgroundColor : null;
      }),
      labels: chips.map(c => c.textContent.trim())
    };
  });
  console.log("initial chip state:", JSON.stringify(initial, null, 2));
  if (initial.count === 0) throw new Error("no chips rendered");
  if (initial.selected !== initial.count) {
    throw new Error(`expected all chips selected by default, got ${initial.selected}/${initial.count}`);
  }
  if (initial.swatchColors.some(c => !c || c === "rgba(0, 0, 0, 0)")) {
    throw new Error("some chips have empty/transparent swatch color");
  }
  if (!/^\d+\/\d+$/.test(initial.countText || "")) {
    throw new Error("count text not in N/N format");
  }
  if (initial.countText !== `${initial.selected}/${initial.count}`) {
    throw new Error(`count text mismatch: '${initial.countText}' vs ${initial.selected}/${initial.count}`);
  }

  // Screenshot before any interaction
  await page.screenshot({ path: `${OUT}/smoke-day-chips-1-initial.png`, fullPage: false });

  // 5) Click "Last 3" preset
  await page.click('.day-chip-preset[data-preset="last3"]');
  await page.waitForTimeout(500);
  const last3 = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#thermal-day-chips .day-chip"));
    return {
      countText: document.getElementById("thermal-day-chips-count")?.textContent,
      selected: chips.filter(c => c.classList.contains("selected")).length
    };
  });
  console.log("after Last 3:", JSON.stringify(last3));
  if (last3.selected !== 3) throw new Error(`expected 3 selected after Last 3, got ${last3.selected}`);
  if (last3.countText !== `3/${initial.count}`) throw new Error(`expected count text '3/${initial.count}', got '${last3.countText}'`);
  await page.screenshot({ path: `${OUT}/smoke-day-chips-2-last3.png`, fullPage: false });

  // 6) Click "All" preset, should restore everything
  await page.click('.day-chip-preset[data-preset="all"]');
  await page.waitForTimeout(500);
  const all = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#thermal-day-chips .day-chip"));
    return {
      countText: document.getElementById("thermal-day-chips-count")?.textContent,
      selected: chips.filter(c => c.classList.contains("selected")).length
    };
  });
  console.log("after All:", JSON.stringify(all));
  if (all.selected !== initial.count) throw new Error(`All did not restore: got ${all.selected}/${initial.count}`);

  // 7) Click "None", should empty
  await page.click('.day-chip-preset[data-preset="none"]');
  await page.waitForTimeout(500);
  const none = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#thermal-day-chips .day-chip"));
    return {
      countText: document.getElementById("thermal-day-chips-count")?.textContent,
      selected: chips.filter(c => c.classList.contains("selected")).length,
      unselected: chips.filter(c => c.classList.contains("unselected")).length
    };
  });
  console.log("after None:", JSON.stringify(none));
  if (none.selected !== 0) throw new Error("None did not empty");
  if (none.unselected !== initial.count) throw new Error("None did not mark all as unselected");

  // 8) Click first chip directly (toggles it back on)
  await page.click("#thermal-day-chips .day-chip:first-child");
  await page.waitForTimeout(300);
  const toggle1 = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#thermal-day-chips .day-chip"));
    return {
      selected: chips.filter(c => c.classList.contains("selected")).length,
      firstDate: chips[0]?.dataset.date,
      firstSelected: chips[0]?.classList.contains("selected")
    };
  });
  console.log("after toggling first chip:", JSON.stringify(toggle1));
  if (toggle1.selected !== 1) throw new Error("first chip toggle did not select 1 chip");

  // 9) Build fingerprint check
  const fp = await page.evaluate(() => window.__VIEW_BUILD_THERMAL || null);
  console.log("build fingerprint:", JSON.stringify(fp, null, 2));
  if (!fp) throw new Error("no build fingerprint");
  if (fp.dayChipMultiSelect !== true) throw new Error("dayChipMultiSelect fingerprint missing");
  if (fp.buildTag !== "dashboard-v2-2026-06-13T11:50") {
    console.warn(`build tag mismatch: ${fp.buildTag}`);
  }

  console.log("\nALL ASSERTIONS PASSED");
  console.log("Console logs from page:");
  for (const l of logs.slice(-20)) console.log("  ", l);

  await browser.close();
}

main().catch(e => {
  console.error("SMOKE FAILED:", e.message);
  console.error(e.stack);
  process.exit(1);
});
