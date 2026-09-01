// Standalone unit test for guessFieldsFromOcrText() and its helpers, extracted
// out of app.js the same way parseQr() has been tested elsewhere in this repo:
// find the function source, eval it in isolation, call it directly. This lets
// us check the OCR-guessing regexes against REAL Tesseract output (captured
// 2026-08-31 from the two real label photos) without needing a browser.
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');

function extract(name) {
  var re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}');
  var m = src.match(re);
  if (!m) throw new Error('Could not find function ' + name + '() in app.js');
  return m[0];
}
function extractVar(name) {
  var re = new RegExp('var ' + name + ' = [^;]+;');
  var m = src.match(re);
  if (!m) throw new Error('Could not find var ' + name + ' in app.js');
  return m[0];
}

eval(extractVar('JOB_CANDIDATE_RE'));
eval(extractVar('MFG_RE'));
eval(extractVar('ASSY_RE'));
eval(extractVar('PART_RE'));
eval(extractVar('PART_ALT_RE'));
eval(extractVar('QTY_RE'));
eval(extractVar('JOB_LOOKALIKE'));
eval(extract('correctJobCandidate'));
eval(extract('normalizeCodeToken'));
eval(extract('guessFieldsFromOcrText'));

// Real Tesseract output, captured 2026-08-31 against the vendored local OCR
// assets (not the CDN) — see /tmp/tesseract-test/test_ocr.js.
var PHOTO1_TEXT = [
  '=~',
  'VTTD1-10.05_A',
  'sone 02-D3-106 ]',
  '- 487.8x387.8 010559-16-1 |',
  'B ivnt. 26-10283-00.VTTD1 SB_A',
  '0.8PL201 G1vnt.',
  'Paras',
].join('\n');

var PHOTO2_TEXT = [
  '25-33724-03.28.05 A Cee',
  'Galiné sienelé (viduriné dalis) Golesi',
  '642.6x287.2 O70481-1-4',
  '4ynt. 25-33724-00,00,00 SB_A',
  '0.8PL201 Givnt',
].join('\n');

// Real Tesseract output captured 2026-09-01 from a THIRD, sharper photo of the
// same VTTD1-10.05_A label — this time with tessedit_pageseg_mode explicitly
// forced to '3' (automatic page segmentation), which read noticeably more of
// the label than whatever Tesseract falls back to when that isn't set
// explicitly (same photo, unset PSM, missed almost everything — see
// test_ocr_psm.js in /tmp during this investigation). This is also the photo
// that revealed a second real part-numbering scheme ("VTTD1-10.05_A", letter-
// prefixed) distinct from the numeric-prefixed one on photo 2, hence
// PART_ALT_RE.
var PHOTO3_TEXT = [
  'VTTD1-10.05_A F_SL',
  'Lentyna 02-D3-106 z',
  '~4 487.8x387.8',
  '',
  '010559-16-1',
  '',
  'ho 26-10283-00.VTTD1 SB_A |',
  '0.8PL201 Givnt.',
  '',
  'rea',
].join('\n');

// Real Tesseract output captured 2026-09-01 from a real, full-scene phone photo
// of this same physical label (label small within a much larger background —
// a wall, pipes, a company logo) AFTER cropping it down to just the label
// region, simulating the app's new capture-crop fix. The SAME full, uncropped
// photo produced completely empty OCR output with internal segmentation
// errors — this is the concrete before/after proof that cropping to the
// on-screen guide box (not just PSM/regex tuning) was the real fix needed.
var PHOTO4_TEXT = [
  'VTTD1-10.05 A',
  'Lentyna 02-D3-106',
  '487.8x387.8',
  '',
  '010559-16-1',
  '',
  '1vnt. 26-10283-00.VTTD1 SB_A',
  '',
  'Givnt.',
].join('\n');

var cases = [
  {
    name: 'Photo 1 (VTTD1-10.05_A label)',
    text: PHOTO1_TEXT,
    // Ground truth from the real physical label: job "010559-16-1" and part
    // "VTTD1-10.05_A" both came through clean here (quantity was the field
    // garbled on this particular weak capture — see photo 3 below for a
    // sharper capture of the very same physical label).
    expect: { mfg: '02-D3-106', assy: '26-10283-00.VTTD1 SB_A', job: '010559-16-1', part: 'VTTD1-10.05_A', qty: undefined },
  },
  {
    name: 'Photo 2 (25-33724 label)',
    text: PHOTO2_TEXT,
    // Ground truth job number is "010481-1-1" — OCR misread digits beyond
    // letter/digit confusion (1->7, 1->4), so the corrected guess "070481-1-4"
    // is EXPECTED to still be wrong; the point of this test is that it stays
    // a plausible-shaped guess for the operator to fix, not that it's correct.
    expect: { job: '070481-1-4', assy: '25-33724-00.00.00 SB_A', part: '25-33724-03.28.05_A', qty: '4', mfg: undefined },
  },
  {
    name: 'Photo 3 (VTTD1-10.05_A label, PSM=3, sharper capture)',
    text: PHOTO3_TEXT,
    // Ground truth: job "010559-16-1", mfg "02-D3-106", assembly
    // "26-10283-00.VTTD1 SB_A", part "VTTD1-10.05_A" (the letter-prefixed
    // scheme PART_ALT_RE exists for), quantity "1vnt." — the one field
    // Tesseract dropped from its output entirely on this capture, so qty
    // stays an honest blank rather than a wrong guess.
    expect: { job: '010559-16-1', mfg: '02-D3-106', assy: '26-10283-00.VTTD1 SB_A', part: 'VTTD1-10.05_A', qty: undefined },
  },
  {
    name: 'Photo 4 (same VTTD1 label, real full-scene phone photo, CROPPED to the label)',
    text: PHOTO4_TEXT,
    // With the crop applied, all 5 fields are correctly recovered — including
    // quantity, which no other photo in this test file has managed to recover.
    expect: { job: '010559-16-1', mfg: '02-D3-106', assy: '26-10283-00.VTTD1 SB_A', part: 'VTTD1-10.05_A', qty: '1' },
  },
];

var failures = 0;
cases.forEach(function (c) {
  var got = guessFieldsFromOcrText(c.text);
  console.log('=== ' + c.name + ' ===');
  console.log('guessed:', got);
  Object.keys(c.expect).forEach(function (field) {
    var exp = c.expect[field];
    var act = got[field];
    var ok = exp === act;
    if (!ok) failures++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + field + ': expected ' + JSON.stringify(exp) + ', got ' + JSON.stringify(act));
  });
});

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
