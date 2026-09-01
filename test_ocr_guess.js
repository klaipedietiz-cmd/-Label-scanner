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

var cases = [
  {
    name: 'Photo 1 (VTTD1-10.05_A label)',
    text: PHOTO1_TEXT,
    // Ground truth from the real physical label: job number "010559-16-1"
    // came through clean here (this was NOT the field that was garbled on
    // this particular capture — part/quantity were). Confirms the job regex
    // correctly finds it without needing any letter-correction.
    expect: { mfg: '02-D3-106', assy: '26-10283-00.VTTD1 SB_A', job: '010559-16-1', part: undefined, qty: undefined },
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
