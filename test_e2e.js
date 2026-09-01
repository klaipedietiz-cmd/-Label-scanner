const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      '--use-fake-ui-for-media-stream',   // auto-grant camera permission prompt
      '--use-fake-device-for-media-stream', // synthetic test video feed instead of a real camera
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    permissions: ['camera'],
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

  await page.goto('http://localhost:8080/index.html');
  await page.waitForTimeout(1500); // let camera + scan loop spin up

  console.log('--- Scan screen loaded ---');
  console.log('shutter visible:', await page.isVisible('#shutter-btn'));

  // Go to manual entry (bypasses camera dependency for a full-flow smoke test)
  await page.click('#manual-link');
  await page.waitForSelector('#screen-manual.active');
  console.log('--- Manual entry screen active ---');

  await page.fill('#m-job', '010127-1-1');
  await page.fill('#m-mfg', '10-D1-61');
  await page.fill('#m-assy', '26-29813-01.00.00 SB_A');
  await page.fill('#m-part', '26-29819-01.00.01_A');
  const continueDisabledBeforeQty = await page.getAttribute('#manual-continue-btn', 'disabled');
  console.log('continue disabled before qty filled (expect "" i.e. present):', continueDisabledBeforeQty);
  await page.fill('#m-qty', '5');
  const continueDisabled = await page.getAttribute('#manual-continue-btn', 'disabled');
  console.log('continue disabled after all 5 fields filled (expect null):', continueDisabled);
  await page.click('#manual-continue-btn');

  await page.waitForSelector('#screen-review.active');
  console.log('--- Review screen active ---');
  const sourceNote = await page.textContent('#review-source-note');
  console.log('source note:', sourceNote);
  const fieldsBadge = await page.textContent('#fields-badge');
  console.log('fields badge (expect 5 / 5 fields — qty now collected in Manual Entry):', fieldsBadge.trim());

  // tap-to-edit a field
  await page.click('[data-field-tap="job"]');
  await page.fill('[data-field-input="job"]', '010127-1-1-EDITED');
  await page.click('#note-input'); // blur the field input by focusing elsewhere
  await page.waitForTimeout(200);
  const jobVal = await page.textContent('[data-field-tap="job"]');
  console.log('job value after inline edit:', jobVal);

  // Quantity is now collected up front in Manual Entry (m-qty), same as job/mfg/
  // assy/part — so the badge above should already read "5 / 5 fields" without
  // any extra tap-to-edit step here.
  const qtyFieldVal = await page.textContent('[data-field-tap="qty"]');
  console.log('qty field value carried into Review from Manual Entry (expect 5):', qtyFieldVal.trim());

  // pick target + reason + note
  await page.click('[data-target="assy"]');
  const chips = await page.$$('.reason-chip:not(.new-chip)');
  console.log('reason chip count (expect 8 defaults):', chips.length);
  const preSelected = await page.$('.reason-chip.selected');
  console.log('a reason pre-selected on entering review (expect null):', preSelected);
  const reasonName = await page.$eval('.reason-chip:not(.new-chip)', el => el.getAttribute('data-reason'));
  const reasonSel = '[data-reason="' + reasonName + '"]';
  await page.click(reasonSel);
  console.log('reason selected after 1 click:', await page.$eval(reasonSel, el => el.classList.contains('selected')));
  await page.click(reasonSel); // click same chip again — should deselect
  const stillSelected = await page.$$('.reason-chip.selected');
  console.log('reason chips selected after clicking same chip twice (expect 0):', stillSelected.length);
  await page.click(reasonSel); // re-select for the rest of the flow
  await page.fill('#note-input', 'Test note from automated check.');

  // submit should stay disabled until Būsena + Būklė are both chosen
  const disabledBeforeChoice = await page.getAttribute('#submit-btn', 'disabled');
  console.log('submit disabled before Būsena/Būklė chosen (expect "" i.e. present):', disabledBeforeChoice);
  const banner = await page.textContent('#qr-error-banner');
  console.log('banner before choice:', banner.trim());

  await page.click('[data-busena="Technologui išrašyti"]');
  await page.click('[data-bukle="Brokas"]');
  const disabledAfterChoice = await page.getAttribute('#submit-btn', 'disabled');
  console.log('submit disabled after Būsena/Būklė chosen (expect null):', disabledAfterChoice);

  // new fields: summary extra words + quantity chooser
  await page.fill('#summary-extra-input', 'bandymas panaudoti skanavimą');
  await page.fill('#qty-total-input', '12');
  await page.click('[data-qty-choice="all"]');

  // payload preview
  await page.click('#payload-toggle-btn');
  const payload = await page.textContent('#payload-pre');
  console.log('--- Payload preview ---');
  console.log(payload);

  // library sheet open/add/remove
  await page.click('#open-library-btn');
  await page.waitForSelector('#library-sheet-backdrop.show');
  await page.fill('#reason-draft-input', 'Automated test reason');
  await page.click('#add-reason-btn');
  await page.waitForTimeout(100);
  const libRows = await page.$$('.sheet-row');
  console.log('library rows after add:', libRows.length);
  await page.click('#close-library-btn');

  // submit -> posting -> done
  await page.click('#submit-btn');
  await page.waitForSelector('#screen-posting.active');
  console.log('--- Posting screen active ---');
  await page.waitForSelector('#screen-done.active', { timeout: 5000 });
  console.log('--- Done screen active ---');
  const doneSummary = await page.textContent('#done-summary');
  const doneKey = await page.textContent('#done-key');
  console.log('done summary:', doneSummary);
  console.log('done key:', doneKey);

  // the fixed "Open in YouTrack" bug: should reveal the mock note, not restart scanning
  await page.click('#open-youtrack-btn');
  const stillDone = await page.isVisible('#screen-done.active');
  const mockNoteShown = await page.isVisible('#mock-note.show');
  console.log('still on done screen after clicking Open in YouTrack (expect true):', stillDone);
  console.log('mock note shown (expect true):', mockNoteShown);

  await page.click('#scan-next-btn');
  await page.waitForSelector('#screen-scan.active');
  console.log('--- Back on scan screen ---');

  console.log('\n=== CONSOLE/PAGE ERRORS ===');
  console.log(errors.length ? errors : 'none');

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('TEST SCRIPT ERROR:', e); process.exit(1); });
