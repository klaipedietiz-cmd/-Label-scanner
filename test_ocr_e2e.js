// Exercises the real OCR-capture path end to end in a browser: switch to the
// "OCR fallback" tab, press the shutter, wait for Tesseract to run against the
// captured frame (a synthetic fake-camera feed, since Playwright can't hold a
// real label up to a webcam), and confirm the app doesn't hang or error and
// correctly lands on Manual Entry with the "couldn't confidently read" banner
// (since a synthetic test pattern has no real label text to find).
const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    permissions: ['camera'],
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

  await page.goto('http://localhost:8080/index.html');
  await page.waitForTimeout(1500);

  await page.click('#tab-ocr');
  console.log('--- OCR tab active ---');
  console.log('scan hunt text:', (await page.textContent('#scan-hunt')).trim());

  await page.click('#shutter-btn');
  console.log('--- Shutter pressed, waiting for OCR (Tesseract engine load + recognize)... ---');

  // Give it real time: first-run fetches ~5.8MB of engine/model files locally
  // and then runs recognition — can take a while on this sandbox's CPU.
  await page.waitForSelector('#screen-manual.active', { timeout: 60000 });
  console.log('--- Landed on Manual Entry ---');

  const bannerVisible = await page.isVisible('#manual-info-banner');
  const bannerText = bannerVisible ? (await page.textContent('#manual-info-banner')).trim() : '(hidden)';
  console.log('info banner visible:', bannerVisible, '| text:', bannerText);

  const vals = {};
  for (const id of ['m-job', 'm-mfg', 'm-assy', 'm-part', 'm-qty']) {
    vals[id] = await page.inputValue('#' + id);
  }
  console.log('field values after OCR (synthetic feed — expect all blank, no crash):', vals);

  console.log('\n=== CONSOLE/PAGE ERRORS ===');
  console.log(errors.length ? errors : 'none');

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('TEST SCRIPT ERROR:', e); process.exit(1); });
