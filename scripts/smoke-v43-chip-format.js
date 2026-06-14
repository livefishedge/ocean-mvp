// v4.3 chip formatter + label contract test.
// Runs offline. Verifies:
//   1. combinedChlFormatRelativeShort() output for known deltas
//   2. Served index.html contains the v4.3 contract (function + header + class)
//   3. Served __VIEW_BUILD_COMBINED fingerprint includes v4.3 fields
//   4. Post-poll hook in served HTML does NOT contain
//      "s.initialized = false" (the bug that was reverted)
//
// Usage: NODE_PATH=$(npm root -g) node scripts/smoke-v43-chip-format.js
// Optional: SMOKE_URL=https://livefishedge.github.io/view/ to verify served HTML.
const https = require("https");
const { URL } = require("url");

const BASE = process.env.SMOKE_URL || "https://livefishedge.github.io/view/";
const INDEX_HTML = `${BASE.replace(/\/?$/, "/")}index.html`;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(new URL(res.headers.location, url).toString()).then(resolve, reject);
      }
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function combinedChlFormatRelativeShort(t, referenceT) {
  if (!Number.isFinite(t) || !Number.isFinite(referenceT)) return "?";
  const deltaMs = referenceT - t;
  if (deltaMs < 0) return "0h";
  const totalMinutes = Math.round(deltaMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return totalHours === 0 ? "0h" : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remH = totalHours - days * 24;
  if (remH === 0) return `${days}d`;
  return `${days}d ${remH}h`;
}

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
}

async function testFormatter() {
  console.log("\n=== TEST 1: combinedChlFormatRelativeShort formatter ===");
  const ref = 1749920280000; // arbitrary reference
  const cases = [
    { offset_h: 0,   expect: "0h",  desc: "newest frame" },
    { offset_h: 1,   expect: "1h",  desc: "1 hour ago" },
    { offset_h: 5,   expect: "5h",  desc: "5 hours ago" },
    { offset_h: 12,  expect: "12h", desc: "12 hours ago" },
    { offset_h: 23,  expect: "23h", desc: "23 hours ago" },
    { offset_h: 24,  expect: "1d",  desc: "1 day exactly" },
    { offset_h: 25,  expect: "1d 1h", desc: "1d 1h" },
    { offset_h: 30,  expect: "1d 6h", desc: "1d 6h" },
    { offset_h: 48,  expect: "2d",  desc: "2 days exactly" },
    { offset_h: 49,  expect: "2d 1h", desc: "2d 1h" },
    { offset_h: 72,  expect: "3d",  desc: "3 days exactly" },
    { offset_h: 100, expect: "4d 4h", desc: "4d 4h" },
    { offset_min: 30, expect: "0h", desc: "30 min ago rounds to 0h" },
  ];
  for (const c of cases) {
    let t;
    if ("offset_h" in c) t = ref - c.offset_h * 3600000;
    else if ("offset_min" in c) t = ref - c.offset_min * 60000;
    const got = combinedChlFormatRelativeShort(t, ref);
    assert(got === c.expect, `${c.desc}: expected '${c.expect}' got '${got}'`);
    console.log(`  PASS  ${c.desc.padEnd(22)} => ${got}`);
  }
  // Edge cases
  assert(combinedChlFormatRelativeShort(null, ref) === "?", "null t -> '?'");
  assert(combinedChlFormatRelativeShort(ref, null) === "?", "null ref -> '?'");
  assert(combinedChlFormatRelativeShort(NaN, ref) === "?", "NaN t -> '?'");
  assert(combinedChlFormatRelativeShort(ref + 3600000, ref) === "0h", "future t -> '0h'");
  console.log("  PASS  edge cases (null/NaN/future)");
}

async function testServedContract() {
  console.log(`\n=== TEST 2: served HTML at ${INDEX_HTML} ===`);
  const res = await fetchText(INDEX_HTML);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  console.log(`  PASS  HTTP 200, ${res.body.length} bytes`);
  const body = res.body;

  // 2a) v4.3 function present
  assert(/function\s+combinedChlFormatRelativeShort\s*\(/.test(body),
    "combinedChlFormatRelativeShort function not found in served HTML");
  console.log("  PASS  combinedChlFormatRelativeShort() present");

  // 2b) v4.3 header div
  assert(/<div\s+class="day-chips-relative-label"[^>]*>Hours ago<\/div>/.test(body),
    "'Hours ago' header div not found in served HTML");
  console.log("  PASS  'Hours ago' header div present");

  // 2c) v4.3 CSS class
  assert(/\.day-chips-relative-label\s*\{/.test(body),
    ".day-chips-relative-label CSS rule not found in served HTML");
  console.log("  PASS  .day-chips-relative-label CSS rule present");

  // 2d) Bug removed: post-poll hook no longer sets s.initialized = false
  // The v4.2 bug was: "s.initialized = false;" inside the post-refresh
  // branch. Search for that line in the loadIndex post-hook area.
  const postHookMatch = body.match(/v4\.2 captain's-dashboard fix[\s\S]{0,4000}?combinedChlInitPanel\(\)/);
  assert(postHookMatch, "could not locate post-refresh block in served HTML");
  assert(!/s\.initialized\s*=\s*false/.test(postHookMatch[0]),
    "s.initialized = false still present in post-refresh hook — bug not fixed");
  console.log("  PASS  post-refresh hook no longer wipes s.initialized");

  // 2e) v4.3 fix block: cache eviction by current ids
  assert(/for \(const cachedId of s\.cache\.keys\(\)\)[\s\S]{0,200}?currentIds\.has\(cachedId\)/.test(body),
    "per-id cache eviction not present in served HTML");
  console.log("  PASS  per-id cache eviction in post-refresh hook");

  // 2f) v4.3 fingerprint fields in __VIEW_BUILD_COMBINED
  const fpMatch = body.match(/__VIEW_BUILD_COMBINED[\s\S]{0,3500}?\}\);/);
  assert(fpMatch, "could not locate __VIEW_BUILD_COMBINED block");
  assert(/chlChipLabelFormat:\s*"relative/.test(fpMatch[0]),
    "fp.chlChipLabelFormat missing/wrong");
  assert(/chlChipSurvivesPoll:\s*true/.test(fpMatch[0]),
    "fp.chlChipSurvivesPoll missing/wrong");
  assert(/chlChipTimeFromFrame:\s*true/.test(fpMatch[0]),
    "fp.chlChipTimeFromFrame missing/wrong");
  console.log("  PASS  __VIEW_BUILD_COMBINED has v4.3 fields");
}

async function main() {
  await testFormatter();
  await testServedContract();
  console.log("\nALL v4.3 ASSERTIONS PASSED");
}

main().catch(e => { console.error("FAIL:", e.message); console.error(e.stack); process.exit(1); });
