// Smoke test for the v4.2 captain's-dashboard CHL chip multi-select
// (commit depends on this being the deployed captain's-dashboard fix).
//
// Mike, 2026-06-13 14:01 ET: "give the user options to choose any of
// the past 10 CHL frames that have >10% valid data coverage of the
// region of interest. Do it like chips, if multiple chips are
// selected, do the composite."
//
// Runs against the local livefishedge Pages URL (or override with
// SMOKE_URL env var). Asserts:
//   1. Combined mode loads, fingerprint has chlChipMultiSelect: true
//   2. CHL layer on reveals the chip panel
//   3. Up to 10 chips are listed (last-N window)
//   4. Sub-10% coverage frames are disabled with the "below 10% gate" tooltip
//   5. Single-chip selection shows the exact frame time
//   6. Multi-chip selection triggers a median composite and the
//      scan-time label shows "Median of K frames: <earliest> - <latest>"
//   7. All 5 presets work: All eligible / None / Latest 1 / Latest 3 / Latest 5
//   8. UV "currents" layer scan-time is the NEWEST UV frame timestamp
//      (Mike's report: "currents layer shows stable data or time stamp"
//       was caused by the layer being built once from the oldest frame)
//   9. UV hours select rebuilds the layer and updates the label
//
// Screenshots are saved to /tmp/smoke-chl-chips-*.png for visual review.
const { chromium } = require("playwright");

const URL = process.env.SMOKE_URL || "https://livefishedge.github.io/view/?region=usec_south&var=combined";
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

  // Wait for combined mode controls to mount.
  await page.waitForSelector("#combined-controls", { timeout: 30000 });
  await page.waitForSelector("#combined-chl-chips-panel", { timeout: 15000 });

  // 1) Build fingerprint check (this is the strongest "is the new
  //    code actually running" signal we have).
  const fp = await page.evaluate(() => window.__VIEW_BUILD_COMBINED || null);
  console.log("build fingerprint:", JSON.stringify(fp, null, 2));
  if (!fp) throw new Error("no __VIEW_BUILD_COMBINED fingerprint");
  if (fp.chlChipMultiSelect !== true) throw new Error("chlChipMultiSelect fingerprint missing");
  if (fp.chlChipMaxFrames !== 10) throw new Error("chlChipMaxFrames fingerprint wrong");
  if (fp.chlChipCoverageGatePct !== 10) throw new Error("chlChipCoverageGatePct fingerprint wrong");
  if (!Array.isArray(fp.chlChipPresets) || fp.chlChipPresets.length !== 5) {
    throw new Error("chlChipPresets fingerprint wrong");
  }

  // 2) Panel hidden by default (CHL checkbox state)
  const initialHidden = await page.$eval("#combined-chl-chips-panel", el => el.classList.contains("hidden"));
  console.log("chl chip panel hidden at load:", initialHidden);

  // 3) Turn CHL on -> panel should reveal and chips should populate
  await page.check("#chk-combined-chl");
  await page.waitForTimeout(500);
  const visibleNow = !(await page.$eval("#combined-chl-chips-panel", el => el.classList.contains("hidden")));
  if (!visibleNow) throw new Error("chl chip panel did not reveal after CHL on");
  console.log("chl chip panel visible after CHL on:", visibleNow);

  // 4) Wait for chips to be built (coverage fetch is async)
  await page.waitForFunction(
    () => document.querySelectorAll("#combined-chl-chips .day-chip").length > 0,
    { timeout: 30000 }
  );

  const initial = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("#combined-chl-chips .day-chip"));
    return {
      count: chips.length,
      selected: chips.filter(c => c.classList.contains("selected")).length,
      disabled: chips.filter(c => c.disabled).length,
      countText: document.getElementById("combined-chl-chips-count")?.textContent,
      labels: chips.map(c => ({
        text: c.textContent.trim(),
        title: c.title,
        disabled: c.disabled
      })),
      state: window._combinedChl ? {
        initialized: window._combinedChl.initialized,
        selected: window._combinedChl.selectedFrameIds.size,
        eligible: window._combinedChl.eligibleFrameIds.size,
        cached: window._combinedChl.cache.size
      } : null
    };
  });
  console.log("initial chip state:", JSON.stringify(initial, null, 2));

  if (initial.count === 0) throw new Error("no CHL chips rendered");
  if (initial.count > 10) throw new Error(`too many chips: ${initial.count} (cap is 10)`);
  if (initial.selected === 0) throw new Error("no chips selected by default (expected Latest 1)");
  if (!/^\d+\/\d+$/.test(initial.countText || "")) {
    throw new Error(`count text not in N/N format: '${initial.countText}'`);
  }

  // 5) Sub-10% coverage: every disabled chip should have a tooltip
  //    that mentions "below 10% gate"
  for (const c of initial.labels) {
    if (c.disabled && !/below 10% gate/.test(c.title || "")) {
      throw new Error(`disabled chip missing 'below 10% gate' tooltip: '${c.title}'`);
    }
  }

  await page.screenshot({ path: `${OUT}/smoke-chl-chips-1-initial.png`, fullPage: false });

  // 6) Single chip: scan-time label should be that frame's time
  //    (not a mean). Click the first eligible chip explicitly.
  // Reset to Latest 1 first.
  await page.click('.day-chip-preset[data-preset="latest1"]');
  await page.waitForTimeout(800);
  const single = await page.evaluate(() => ({
    selected: window._combinedChl?.selectedFrameIds.size,
    scanTime: document.getElementById("combined-chl-scan-time")?.textContent,
    selectedIds: Array.from(window._combinedChl?.selectedFrameIds || [])
  }));
  console.log("after Latest 1:", JSON.stringify(single));
  if (single.selected !== 1) throw new Error(`expected 1 selected after Latest 1, got ${single.selected}`);
  if (!single.scanTime || /Median of \d+ frames/.test(single.scanTime)) {
    throw new Error(`single-chip scanTime should be a single time, got: '${single.scanTime}'`);
  }
  if (single.scanTime === "Pick at least one chip") {
    throw new Error("single-chip label is the placeholder");
  }

  // 7) Multi-chip: Latest 3 should give a "Median of 3 frames: ..." label
  await page.click('.day-chip-preset[data-preset="latest3"]');
  await page.waitForTimeout(1500);
  const multi = await page.evaluate(() => ({
    selected: window._combinedChl?.selectedFrameIds.size,
    scanTime: document.getElementById("combined-chl-scan-time")?.textContent,
    layer: !!window._combinedChlLayer
  }));
  console.log("after Latest 3:", JSON.stringify(multi));
  if (multi.selected !== 3) throw new Error(`expected 3 selected after Latest 3, got ${multi.selected}`);
  if (!/Median of 3 frames:/.test(multi.scanTime || "")) {
    throw new Error(`expected 'Median of 3 frames: ...' label, got: '${multi.scanTime}'`);
  }
  if (!multi.layer) throw new Error("CHL composite layer not added after Latest 3");

  // 8) None: layer should be removed, label = "Pick at least one chip"
  await page.click('.day-chip-preset[data-preset="none"]');
  await page.waitForTimeout(800);
  const none = await page.evaluate(() => ({
    selected: window._combinedChl?.selectedFrameIds.size,
    scanTime: document.getElementById("combined-chl-scan-time")?.textContent,
    layer: !!window._combinedChlLayer
  }));
  console.log("after None:", JSON.stringify(none));
  if (none.selected !== 0) throw new Error("None did not empty");
  if (none.scanTime !== "Pick at least one chip") {
    throw new Error(`expected 'Pick at least one chip' label, got: '${none.scanTime}'`);
  }
  if (none.layer) throw new Error("CHL layer still present after None");

  // 9) All eligible: count text should be N/N where N = eligible
  await page.click('.day-chip-preset[data-preset="all"]');
  await page.waitForTimeout(800);
  const allState = await page.evaluate(() => ({
    selected: window._combinedChl?.selectedFrameIds.size,
    eligible: window._combinedChl?.eligibleFrameIds.size,
    countText: document.getElementById("combined-chl-chips-count")?.textContent,
    scanTime: document.getElementById("combined-chl-scan-time")?.textContent
  }));
  console.log("after All eligible:", JSON.stringify(allState));
  if (allState.eligible > 0 && allState.selected !== allState.eligible) {
    throw new Error(`All eligible should select all eligible, got ${allState.selected}/${allState.eligible}`);
  }
  if (allState.eligible > 1 && !/Median of \d+ frames:/.test(allState.scanTime || "")) {
    throw new Error(`All eligible (>1) should show median label, got: '${allState.scanTime}'`);
  }

  // 10) Latest 5 preset
  await page.click('.day-chip-preset[data-preset="latest5"]');
  await page.waitForTimeout(800);
  const l5 = await page.evaluate(() => ({
    selected: window._combinedChl?.selectedFrameIds.size,
    scanTime: document.getElementById("combined-chl-scan-time")?.textContent
  }));
  console.log("after Latest 5:", JSON.stringify(l5));
  if (l5.selected > 5) throw new Error(`Latest 5 selected too many: ${l5.selected}`);
  if (l5.selected > 1 && !/Median of \d+ frames:/.test(l5.scanTime || "")) {
    throw new Error(`Latest 5 (>1) should show median label, got: '${l5.scanTime}'`);
  }

  await page.screenshot({ path: `${OUT}/smoke-chl-chips-2-multi.png`, fullPage: false });

  // 11) UV layer: scan-time label must be the NEWEST UV frame's
  //     timestamp, not a frozen one from page load.
  const uvBefore = await page.evaluate(() => ({
    layer: !!window._combinedUvLayer,
    scanTime: document.getElementById("combined-uv-scan-time")?.textContent,
    uvFrames: (framesByVar.uv || []).map(f => epochMsForFrame("uv", f)).filter(t => Number.isFinite(t)),
    hoursSel: document.getElementById("combined-uv-hours")?.value
  }));
  console.log("uv state:", JSON.stringify(uvBefore, null, 2));
  if (uvBefore.uvFrames.length === 0) {
    console.warn("no UV frames in manifest; skipping UV assertions");
  } else {
    const newestUvT = Math.max.apply(null, uvBefore.uvFrames);
    const newestLabel = new Date(newestUvT).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
    if (uvBefore.scanTime && !uvBefore.scanTime.includes(newestLabel)) {
      throw new Error(`UV scan time is not the newest frame's time. expected substring '${newestLabel}', got '${uvBefore.scanTime}'`);
    }
  }

  // 12) UV hours select rebuilds
  await page.selectOption("#combined-uv-hours", "6");
  await page.waitForTimeout(1500);
  const uvAfter = await page.evaluate(() => ({
    scanTime: document.getElementById("combined-uv-scan-time")?.textContent,
    layer: !!window._combinedUvLayer
  }));
  console.log("uv after Last 6 hours:", JSON.stringify(uvAfter));
  if (!/Last 6 hours/.test(uvAfter.scanTime || "")) {
    throw new Error(`expected 'Last 6 hours' in UV label, got: '${uvAfter.scanTime}'`);
  }
  if (!uvAfter.layer) throw new Error("UV layer not present after hours select change");

  await page.screenshot({ path: `${OUT}/smoke-chl-chips-3-uv.png`, fullPage: false });

  console.log("\nALL ASSERTIONS PASSED");
  console.log("Console logs from page (last 20):");
  for (const l of logs.slice(-20)) console.log("  ", l);

  await browser.close();
}

main().catch(e => {
  console.error("SMOKE FAILED:", e.message);
  console.error(e.stack);
  process.exit(1);
});
