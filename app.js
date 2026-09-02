/* Label Scanner — Novameta shop-floor defect reporting
 * -----------------------------------------------------
 * Plain JavaScript, no build step, no framework. Everything lives in one
 * `state` object; each screen has a render function that rebuilds its
 * dynamic HTML from state. This is a TEST PROTOTYPE:
 *   - YouTrack submission is SIMULATED (see submit()) — nothing real is created.
 *   - The defect-reason list is stored locally on this phone (localStorage),
 *     not yet shared across devices via YouTrack, per the "mock it for now" decision.
 *   - OCR fallback is a stub that hands off to manual entry.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  // Shown in the top-right corner of the scan screen, and bumped every time
  // sw.js's CACHE version is bumped. Added 2026-09-02 after several rounds of
  // "I updated GitHub but nothing changed" turned out to be genuinely
  // ambiguous to debug remotely — this makes it possible to just LOOK at the
  // phone and know for certain whether it's actually running the latest
  // build, instead of guessing from behavior.
  var APP_VERSION = 'v14';
  var LABELS = { job: 'Job number', mfg: 'Manuf. code', assy: 'Assembly', part: 'Part no.', qty: 'Quantity' };
  var VALUE_FIELDS = ['job', 'mfg', 'assy', 'part', 'qty']; // quantity mandatory alongside the rest, 2026-08-27
  var DEFAULT_REASONS = ['Weld defect', 'Dimension out of tol.', 'Surface finish', 'Material fault',
    'Wrong part', 'Transport damage', 'Missing feature', 'Paint / coating'];
  // "Būsena" (State) and "Būklė" — real YouTrack QMS project custom fields, confirmed
  // 2026-08-27 via a live GET on an existing issue. Būsena has 5 possible values in
  // YouTrack; per the operator, only these 2 are ever chosen at report time (the rest
  // are used later in the workflow by other staff). Būklė's 3 values are all offered.
  var BUSENA_OPTIONS = ['Technologui išrašyti', 'Perduota atsakingam asm.'];
  var BUKLE_OPTIONS = ['Taisyti (arba trūksta)', 'Brokas', 'Informacinis'];
  var REASONS_KEY = 'nm_defect_reasons';
  var USAGE_KEY = 'nm_defect_reason_usage';
  var MAX_PHOTOS = 6;
  var DOWNSCALE_MAX_DIM = 1600;
  var DOWNSCALE_TARGET_BYTES = 300 * 1024;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var state = {
    screen: 'scan',          // scan | manual | review | posting | done
    mode: 'qr',              // qr | ocr  (the tab on the scan screen)
    locked: false,           // true briefly between a good decode and moving to review
    scanErrorRaw: null,      // last decoded string that failed to parse (shown to the operator)

    source: null,            // 'qr' | 'manual' — how the current values were obtained
    values: null,            // { job, mfg, assy, part }
    rawQr: null,             // the raw string, only set when source === 'qr'
    editingField: null,      // which of job/mfg/assy/part is mid-edit

    target: 'part',          // 'assy' | 'part'
    kind: null,              // selected defect reason
    note: '',
    summaryExtra: '',        // optional operator words appended to the auto-built summary
    busena: null,            // required — one of BUSENA_OPTIONS
    bukle: null,             // required — one of BUKLE_OPTIONS
    qtyTotal: '',            // operator-typed "total on label" (QR doesn't carry quantity yet)
    qtyChoice: null,         // null | '1' | 'all' | 'other'
    qtyOther: '',            // custom typed quantity when qtyChoice === 'other'

    photos: [],              // [{ id, label, dataUrl, removable }]
    nextPhotoNum: 1,

    reasons: [], custom: [],
    libraryOpen: false,
    draft: '',

    showPayload: false,

    posting: false,
    postStage: '',
    issueKey: null,
    nextKey: 1487,

    cameraReady: false,
    cameraError: null,
    manualInfoBanner: false,  // show the "check these values" note on the manual screen
    ocrBusy: false,           // true while Tesseract is recognizing a captured photo
    ocrDebug: null,           // { image, text } from the last OCR attempt — lets the
                              // operator see exactly what the engine was given and read
  };

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function delegate(container, selector, event, handler) {
    container.addEventListener(event, function (e) {
      var el = e.target.closest(selector);
      if (el && container.contains(el)) handler(el, e);
    });
  }
  function showScreen(name) {
    state.screen = name;
    $all('.screen').forEach(function (el) { el.classList.remove('active'); });
    $('#screen-' + name).classList.add('active');
  }

  // ---------------------------------------------------------------------
  // Reason library (localStorage — single device for now)
  // ---------------------------------------------------------------------
  function loadReasons() {
    try {
      var saved = JSON.parse(localStorage.getItem(REASONS_KEY) || 'null');
      if (saved && Array.isArray(saved.reasons) && saved.reasons.length) {
        state.reasons = saved.reasons;
        state.custom = saved.custom || [];
        return;
      }
    } catch (e) { /* ignore corrupt storage */ }
    state.reasons = DEFAULT_REASONS.slice();
    state.custom = [];
    persistReasons();
  }
  function persistReasons() {
    try { localStorage.setItem(REASONS_KEY, JSON.stringify({ reasons: state.reasons, custom: state.custom })); }
    catch (e) { /* storage full or disabled — non-fatal */ }
  }
  function loadUsage() {
    try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function bumpUsage(name) {
    var u = loadUsage();
    u[name] = (u[name] || 0) + 1;
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch (e) { /* non-fatal */ }
  }
  // "Personalise the order, not the content" — most-used-on-this-phone floats to the front.
  function orderedReasons() {
    var u = loadUsage();
    return state.reasons.map(function (name, i) { return { name: name, i: i, c: u[name] || 0 }; })
      .sort(function (a, b) { return b.c - a.c || a.i - b.i; })
      .map(function (r) { return r.name; });
  }

  // ---------------------------------------------------------------------
  // QR payload parsing — "%job;mfg;assy;part;qty%", exactly 5 slots
  // required (quantity mandatory, per 2026-08-27 decision). Confirmed
  // real-label format: "%010127-1-1;10-D1-61;26-29719-01.00.00 SB_A;
  // 26-29719-01.10.02_A;5%". A 4-slot label (no quantity) is now treated
  // as malformed, same as any other bad read.
  //
  // A real scanned label also came back as "$BANDAY$%010127-1-1;10-D1-61;...%" —
  // there's a prefix ("$BANDAY$", likely a test/sample-print marker) before
  // the %...% payload. So this only requires the %...% block to appear
  // somewhere in the scanned text, rather than requiring the whole string
  // to be exactly "%...%" — anything outside the percent markers (a prefix,
  // a trailing newline the scanner added, etc.) is simply ignored.
  // ---------------------------------------------------------------------
  function parseQr(raw) {
    var m = /%([^%]*)%/.exec((raw || '').trim());
    if (!m) return null;
    var parts = m[1].split(';').map(function (s) { return s.trim(); });
    if (parts.length !== 5) return null;
    return { job: parts[0], mfg: parts[1], assy: parts[2], part: parts[3], qty: parts[4] };
  }

  // ---------------------------------------------------------------------
  // OCR fallback — guessing the 5 fields from Tesseract's raw recognized
  // text. Confirmed 2026-08-31 against two real label photos: OCR reliably
  // gets the general shape right (which line is which field) but makes
  // digit-level mistakes, especially on the Job number. So this ONLY ever
  // produces a best-effort guess that pre-fills Manual Entry — the operator
  // must look at and confirm/correct every field before Continue is enabled
  // (checkManualComplete() below doesn't know or care where a value came
  // from). Nothing here is trusted blindly.
  //
  // Shapes below are taken directly from real Novameta labels seen in this
  // build (not invented): Job "010481-1-1" / "010559-16-1", Manufacturing
  // code "03-D1-1" / "02-D3-106" / "[31-D1-7]", Assembly "25-33724-00.00.00
  // SB_A" / "26-10283-00.VTTD1 SB_A" (the middle segment isn't always
  // numeric), Quantity "4vnt." / "1vnt." (a bare "<n>vnt." — a second,
  // letter-prefixed "G1vnt."-style code also appears on labels and is NOT
  // the quantity, per the operator, so it's deliberately excluded).
  //
  // Confirmed 2026-09-01 against 3 more real labels: the part code's shape
  // varies more than just "numeric-prefixed" vs "letter-prefixed" — one used
  // square brackets ("UWP0-00.01[004]_B"), another had two dotted segments
  // after a letter+digit prefix ("XXX22-0002.00.02_A"). Rather than keep
  // adding one narrow pattern per shape seen so far, PART_RE below is now a
  // single general rule: "some code made of letters/digits/dots/hyphens/
  // brackets, then an underscore-or-space, then exactly one trailing letter"
  // — which is the one thing true of every part code seen so far — while
  // still excluding the "... SB_A" assembly suffix so the two don't collide.
  // Also confirmed the assembly reference sometimes has NO "SB_A" suffix at
  // all (e.g. "26-25905-05.00.00") — that shape is too generic to safely
  // match without risking false positives elsewhere, so it's left blank for
  // the operator to fill in rather than guessed.
  // ---------------------------------------------------------------------
  // Tried letting "." stand in for "-" in both of these (confirmed 2026-09-02
  // that Tesseract sometimes reads a label's hyphens as periods on a real
  // phone capture — e.g. "02-D3-104" came back as "02.03-104"), and also
  // letting MFG_RE's middle letter be the digit "0" (D/0 are visually close).
  // REVERTED the same day: both are extremely common inside OTHER fields'
  // legitimate dotted-decimal codes (e.g. "...00.00.00" in an assembly ref),
  // so the loosened patterns started matching fragments of THOSE instead —
  // confirmed via the regression suite, which caught mfg/job guesses
  // appearing on photos where they must correctly stay blank. Not safe to
  // loosen without a smarter recognizer for "which field is this really
  // part of", which regex alone can't do here.
  var JOB_CANDIDATE_RE = /\b[0-9A-Za-z]{5,7}-[0-9A-Za-z]{1,3}-[0-9A-Za-z]{1,3}\b/g;
  var MFG_RE = /\b\d{1,2}-[A-Za-z]\d-\d{1,3}\b/g;
  var ASSY_RE = /\b\d{2}-\d{4,5}-[0-9A-Za-z.,]{2,20}\s*SB[_ .]?A\b/gi;
  var PART_RE = /\b[0-9A-Za-z][0-9A-Za-z.\-\[\]]{3,30}[ _]+(?!SB[_ ]?A\b)[A-Za-z]\b/g;
  // Quantity: a bare "<n>vnt."-style token. Deliberately restricted to
  // same-line whitespace only (no \s, which would cross a newline) and at
  // most 1 letter before "nt" — an earlier, looser version of this regex
  // once matched "00" from an unrelated code several lines away from a
  // stray "...vnt" token by crossing a line break; this doesn't.
  var QTY_RE = /(?:^|[^A-Za-z0-9])(\d{1,4})[ \t]*[a-z]?nt\.?/i;
  // Job numbers are digits only, with the letter F sometimes appearing (per the
  // operator) — no other letters. These are the common OCR digit look-alikes;
  // anything else left over after this substitution means "not a job number".
  var JOB_LOOKALIKE = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

  function correctJobCandidate(tok) {
    var clean = tok.toUpperCase().replace(/[^0-9A-Z-]/g, '');
    var mapped = '';
    for (var i = 0; i < clean.length; i++) {
      var ch = clean[i];
      if (ch === '-' || (ch >= '0' && ch <= '9') || ch === 'F') { mapped += ch; continue; }
      if (JOB_LOOKALIKE[ch]) { mapped += JOB_LOOKALIKE[ch]; continue; }
      return null; // some other letter OCR wouldn't reasonably produce from a digit
    }
    if (!/^[0-9F]+-[0-9F]+-[0-9F]+$/.test(mapped)) return null;
    return mapped;
  }

  function normalizeCodeToken(tok) {
    return tok.replace(/,/g, '.').replace(/\s*SB[_ .]?A\b/i, ' SB_A')
      .replace(/[\s_]+([A-Za-z])$/, '_$1').replace(/\s+/g, ' ').trim();
  }

  function guessFieldsFromOcrText(text) {
    var t = text || '';
    var guesses = {};

    var jobMatches = t.match(JOB_CANDIDATE_RE) || [];
    for (var i = 0; i < jobMatches.length; i++) {
      var corrected = correctJobCandidate(jobMatches[i]);
      if (corrected) { guesses.job = corrected; break; }
    }

    var mfgMatch = t.match(MFG_RE);
    if (mfgMatch) guesses.mfg = mfgMatch[0].toUpperCase();

    var assyMatch = t.match(ASSY_RE);
    if (assyMatch) guesses.assy = normalizeCodeToken(assyMatch[0]);

    var partMatch = t.match(PART_RE);
    if (partMatch) guesses.part = normalizeCodeToken(partMatch[0]);

    var qtyMatch = QTY_RE.exec(t);
    if (qtyMatch) guesses.qty = qtyMatch[1];

    return guesses;
  }

  // ---------------------------------------------------------------------
  // OCR engine (Tesseract.js) — vendored locally under ocr/ so it works
  // offline once cached and never depends on a CDN. tesseract.min.js (the
  // main-thread API) is only fetched the first time OCR mode is actually
  // used, not on every app load; the service worker's normal fetch handler
  // then caches it (and worker.min.js / the core / the trained data) for
  // offline reuse, same as every other file in this app.
  // ---------------------------------------------------------------------
  var OCR_BASE = 'ocr/';
  var ocrWorkerPromise = null;
  function ensureOcrScriptLoaded() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = OCR_BASE + 'tesseract.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load the OCR engine.')); };
      document.head.appendChild(s);
    });
  }
  function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = ensureOcrScriptLoaded().then(function () {
        return window.Tesseract.createWorker('eng', 1, {
          workerPath: OCR_BASE + 'worker.min.js',
          corePath: OCR_BASE + 'tesseract-core-lstm.wasm.js',
          langPath: OCR_BASE, // local dir, not a CDN URL — matches the vendored eng.traineddata.gz
          gzip: true,
          logger: function () {},
        });
      }).then(function (worker) {
        // Confirmed 2026-09-01 against a real label photo: explicitly forcing
        // "automatic page segmentation" (PSM 3) reads noticeably more fields
        // correctly than whatever Tesseract falls back to when this isn't set
        // (that default missed several fields entirely on the same photo).
        //
        // The load_*_dawg params turn OFF Tesseract's English dictionary bias.
        // Confirmed 2026-09-02 on a real phone capture: with it on, Tesseract
        // "corrected" the garbled strokes of "1vnt." into "wont" — an actual
        // English word — instead of leaving the code as unrecognized
        // characters. These labels are alphanumeric codes, never English
        // prose, so that dictionary only ever hurts here.
        return worker.setParameters({
          tessedit_pageseg_mode: '3',
          load_system_dawg: '0',
          load_freq_dawg: '0',
          load_punc_dawg: '0',
          load_number_dawg: '0',
          load_unambig_dawg: '0',
          load_bigram_dawg: '0',
          load_fixed_length_dawgs: '0',
        }).then(function () { return worker; });
      }).catch(function (err) {
        ocrWorkerPromise = null; // allow retrying on the next shutter press
        throw err;
      });
    }
    return ocrWorkerPromise;
  }

  // ---------------------------------------------------------------------
  // Image downscale (client-side, before it ever leaves the phone)
  // Target: longest side <= 1600px, ~300KB, per the build spec.
  // ---------------------------------------------------------------------
  function downscaleDataUrl(srcDataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var w = img.width, h = img.height;
      var scale = Math.min(1, DOWNSCALE_MAX_DIM / Math.max(w, h));
      var cw = Math.round(w * scale), ch = Math.round(h * scale);
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);

      var quality = 0.85, attempts = 0, out = canvas.toDataURL('image/jpeg', quality);
      function approxBytes(dataUrl) { return Math.round(dataUrl.length * 0.75); }
      while (approxBytes(out) > DOWNSCALE_TARGET_BYTES && quality > 0.4 && attempts < 6) {
        quality -= 0.1;
        out = canvas.toDataURL('image/jpeg', quality);
        attempts++;
      }
      cb(out);
    };
    img.onerror = function () { cb(srcDataUrl); };
    img.src = srcDataUrl;
  }

  // ---------------------------------------------------------------------
  // Camera + QR scanning
  // ---------------------------------------------------------------------
  var video = $('#scan-video');
  var canvas = $('#scan-canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var rafId = null;
  var stream = null;
  var lockTimer = null;
  var errorTimer = null;

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraError('This phone browser can\'t access the camera. Use "Enter manually" below.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        state.cameraReady = true;
        state.cameraError = null;
        $('#camera-permission-note').classList.remove('show');
        video.play().catch(function () {});
        startLoop();
      })
      .catch(function (err) {
        var msg = 'Camera access was blocked. Allow it in your browser settings, or enter values manually.';
        if (err && err.name === 'NotFoundError') msg = 'No camera was found on this device. Use "Enter manually" below.';
        showCameraError(msg);
      });
  }
  function showCameraError(msg) {
    state.cameraError = msg;
    $('#camera-permission-text').textContent = msg;
    $('#camera-permission-note').classList.add('show');
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
  function startLoop() { stopLoop(); rafId = requestAnimationFrame(tick); }

  function tick() {
    if (state.screen !== 'scan') { rafId = requestAnimationFrame(tick); return; }
    if (state.mode === 'qr' && !state.locked && video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var code = window.jsQR(imgData.data, imgData.width, imgData.height);
      if (code && code.data) handleDecoded(code.data);
    }
    rafId = requestAnimationFrame(tick);
  }

  function captureFrameDataUrl() {
    if (!video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  // ---------------------------------------------------------------------
  // OCR crop — confirmed 2026-09-01 as the actual root cause of OCR reading
  // nothing on a real photo: the shutter used to hand Tesseract the WHOLE
  // camera frame, but on an un-zoomed real photo the label only fills a
  // small part of that frame (lots of background wall/floor around it), and
  // Tesseract's page segmentation fails outright on that — cropping the
  // exact same frame down to just the label made every field readable.
  // So OCR now only ever runs on the region inside the on-screen "frame the
  // whole label" guide box (.scan-frame-wrap: left/right 8%, top 22%,
  // height 34% of the video's displayed area) — same box the operator is
  // already told to line the label up with — mapped from displayed CSS
  // pixels into the video's native pixel coordinates (accounting for
  // object-fit: cover, which crops/scales the native frame to fill the
  // screen).
  // ---------------------------------------------------------------------
  function computeOcrCropRect() {
    var rect = video.getBoundingClientRect();
    var Wc = rect.width, Hc = rect.height;
    var Wv = video.videoWidth, Hv = video.videoHeight;
    if (!Wc || !Hc || !Wv || !Hv) return null;
    var scale = Math.max(Wc / Wv, Hc / Hv); // object-fit: cover
    var offsetX = (Wv * scale - Wc) / 2;
    var offsetY = (Hv * scale - Hc) / 2;
    var gx = 0.08 * Wc, gy = 0.22 * Hc, gw = 0.84 * Wc, gh = 0.34 * Hc; // matches .scan-frame-wrap in styles.css
    var x0 = (gx + offsetX) / scale, y0 = (gy + offsetY) / scale;
    var x1 = (gx + gw + offsetX) / scale, y1 = (gy + gh + offsetY) / scale;
    var x = Math.max(0, Math.round(x0)), y = Math.max(0, Math.round(y0));
    var w = Math.min(Wv - x, Math.round(x1 - x0)), h = Math.min(Hv - y, Math.round(y1 - y0));
    if (w <= 0 || h <= 0) return null;
    return { x: x, y: y, w: w, h: h };
  }

  // Returns the on-screen guide box crop as its own <canvas> (not a shared
  // one — the module-level canvas/ctx above are also used by the QR loop
  // and the full-frame photo capture, so this must not alias them) so
  // preprocessOcrCrop() below can read its pixels directly. Falls back to
  // the full frame if the crop geometry isn't available yet.
  function captureOcrCropCanvas() {
    if (!video.videoWidth) return null;
    var r = computeOcrCropRect();
    var out = document.createElement('canvas');
    var octx = out.getContext('2d');
    if (!r) {
      out.width = video.videoWidth; out.height = video.videoHeight;
      octx.drawImage(video, 0, 0, out.width, out.height);
      return out;
    }
    out.width = r.w; out.height = r.h;
    octx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return out;
  }

  // ---------------------------------------------------------------------
  // OCR preprocessing — confirmed 2026-09-02 against a real Novameta label
  // photo as the actual fix for Tesseract reading almost nothing on labels
  // like theirs, which mix two rendering styles on the SAME label: bold
  // white text on solid black rounded "badges" (job code, line/cell code,
  // dimensions, etc.) right next to faint plain gray text on the label's
  // tan background (job number, assembly ref, quantity, etc.). Tesseract's
  // own automatic contrast handling can't cope with both styles in one
  // image — tested extensively (every page-segmentation mode, global
  // invert, left/right column splitting) with no real improvement.
  //
  // This fixes it with plain pixel math on the already-captured crop —
  // no server, no cloud OCR service, no new vendored library, nothing
  // that leaves the phone — before handing the result to the exact same
  // local Tesseract engine already used everywhere else in this file:
  //   1. Find the dark rounded "badge" rectangles: threshold the grayscale
  //      crop to a dark/light mask, then connected-component scan it.
  //   2. Re-threshold each badge's own pixels locally (Otsu) so its text
  //      becomes black-on-white like the rest of the label instead of
  //      white-on-black, AND cut it out as its own small image — Tesseract
  //      reads one clean short line far more reliably than a whole busy
  //      page (confirmed 2026-09-02: same badge text went from unreadable
  //      to correct once isolated this way).
  //   3. Locally adaptive-threshold everything else, since the plain text
  //      on these labels is faint gray on a busy tan background, not solid
  //      black on white — a single global threshold either misses it
  //      entirely or wipes it out along with the background. Then band off
  //      every gap above/between/below the badges in the same column (the
  //      plain-text lines live there) and cut those out individually too,
  //      for the same "read it alone" reason as the badges.
  // Returns { compositeCanvas, regions: [{canvas, psm}, ...] } — psm is the
  // Tesseract page-segmentation mode that region should be read with
  // ('7' = single line for badges, '6' = uniform block for line bands,
  // which can hold more than one stacked line). Never
  // throws — falls back to returning just the untouched original crop as
  // compositeCanvas (with no badge crops) if anything goes wrong, so a
  // preprocessing bug degrades to "back to how it worked before", not to
  // a broken capture.
  // ---------------------------------------------------------------------
  function otsuThreshold(gray, w, x0, y0, x1, y1) {
    var hist = new Uint32Array(256), total = 0, x, y, v;
    for (y = y0; y < y1; y++) {
      for (x = x0; x < x1; x++) { v = gray[y * w + x]; hist[v]++; total++; }
    }
    if (!total) return 128;
    var sumAll = 0;
    for (v = 0; v < 256; v++) sumAll += v * hist[v];
    var sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += v * hist[v];
      var mB = sumB / wB, mF = (sumAll - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = v; }
    }
    return best;
  }

  function preprocessOcrCrop(srcCanvas) {
    var fallback = { compositeCanvas: srcCanvas, regions: [] };
    try {
      var w = srcCanvas.width, h = srcCanvas.height;
      if (!w || !h) return fallback;
      var sctx = srcCanvas.getContext('2d');
      var src = sctx.getImageData(0, 0, w, h).data;
      var n = w * h;
      var gray = new Uint8ClampedArray(n);
      var i, x, y;
      for (i = 0; i < n; i++) gray[i] = (src[i * 4] + src[i * 4 + 1] + src[i * 4 + 2]) / 3;

      // --- 1. Dark mask + a touch of dilation to bridge thin anti-aliasing
      // gaps in a badge's border/fill, then connected-component label it.
      var DARK = 90;
      var dark = new Uint8Array(n);
      for (i = 0; i < n; i++) dark[i] = gray[i] < DARK ? 1 : 0;
      var dilated = new Uint8Array(n);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var hit = 0;
          for (var dy = -1; dy <= 1 && !hit; dy++) {
            var ny = y + dy; if (ny < 0 || ny >= h) continue;
            for (var dx = -1; dx <= 1; dx++) {
              var nx = x + dx; if (nx < 0 || nx >= w) continue;
              if (dark[ny * w + nx]) { hit = 1; break; }
            }
          }
          dilated[y * w + x] = hit;
        }
      }

      var labels = new Int32Array(n).fill(-1);
      var stackX = new Int32Array(n), stackY = new Int32Array(n);
      var boxes = []; // {minX,minY,maxX,maxY,count}
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var startIdx = y * w + x;
          if (!dilated[startIdx] || labels[startIdx] !== -1) continue;
          var sp = 0;
          stackX[sp] = x; stackY[sp] = y; sp++;
          labels[startIdx] = boxes.length;
          var minX = x, maxX = x, minY = y, maxY = y, count = 0;
          while (sp > 0) {
            sp--;
            var cx = stackX[sp], cy = stackY[sp];
            count++;
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
            for (var ddy = -1; ddy <= 1; ddy++) {
              var yy = cy + ddy; if (yy < 0 || yy >= h) continue;
              for (var ddx = -1; ddx <= 1; ddx++) {
                var xx = cx + ddx; if (xx < 0 || xx >= w) continue;
                var nIdx = yy * w + xx;
                if (dilated[nIdx] && labels[nIdx] === -1) {
                  labels[nIdx] = boxes.length;
                  stackX[sp] = xx; stackY[sp] = yy; sp++;
                }
              }
            }
          }
          boxes.push({ minX: minX, minY: minY, maxX: maxX, maxY: maxY, count: count });
        }
      }

      // --- Filter to plausible "badge" rectangles: wide, short, mostly-solid
      // bars — deliberately expressed as FRACTIONS of the crop's own size so
      // this works the same whether the crop is a small screenshot or a
      // full-resolution phone photo, not tuned to one specific resolution.
      var badges = [];
      for (i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        var bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
        var fill = b.count / (bw * bh);
        if (bw > 0.08 * w && bh > 0.015 * h && bh < 0.25 * h && (bw / bh) > 1.8 && fill > 0.3 && b.count > 0.003 * n) {
          badges.push(b);
        }
      }
      badges.sort(function (a, b2) { return b2.count - a.count; });
      if (badges.length > 10) badges = badges.slice(0, 10);

      // --- 2. Build the composite: start from a whole-image adaptive
      // threshold (handles the faint plain-gray text), then paint each
      // badge's own locally-Otsu-thresholded region on top of it.
      var R = Math.max(8, Math.round(0.05 * Math.min(w, h)));
      var C = 12;
      // Integral image of gray, for O(1) local-mean lookups.
      var integral = new Float64Array((w + 1) * (h + 1));
      for (y = 0; y < h; y++) {
        var rowSum = 0;
        for (x = 0; x < w; x++) {
          rowSum += gray[y * w + x];
          integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
        }
      }
      function areaSum(x0, y0, x1, y1) { // inclusive-exclusive, clamped by caller
        return integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      }

      var outCanvas = document.createElement('canvas');
      outCanvas.width = w; outCanvas.height = h;
      var octx = outCanvas.getContext('2d');
      var outImg = octx.createImageData(w, h);
      var od = outImg.data;
      for (y = 0; y < h; y++) {
        var y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
        for (x = 0; x < w; x++) {
          var x0 = Math.max(0, x - R), x1b = Math.min(w, x + R + 1);
          var area = (x1b - x0) * (y1 - y0);
          var mean = areaSum(x0, y0, x1b, y1) / area;
          var idx = y * w + x;
          var val = gray[idx] < (mean - C) ? 0 : 255;
          var o = idx * 4;
          od[o] = od[o + 1] = od[o + 2] = val; od[o + 3] = 255;
        }
      }

      var badgeRects = [];
      for (i = 0; i < badges.length; i++) {
        var bb = badges[i];
        var inset = Math.max(3, Math.round(0.08 * (bb.maxY - bb.minY + 1)));
        var rx0 = Math.min(bb.maxX, bb.minX + inset), ry0 = Math.min(bb.maxY, bb.minY + inset);
        var rx1 = Math.max(rx0 + 1, bb.maxX - inset + 1), ry1 = Math.max(ry0 + 1, bb.maxY - inset + 1);
        var t = otsuThreshold(gray, w, rx0, ry0, rx1, ry1);
        for (y = ry0; y < ry1; y++) {
          for (x = rx0; x < rx1; x++) {
            var gi = y * w + x;
            var v2 = gray[gi] > t ? 0 : 255; // text (brighter than badge bg) -> black
            var o2 = gi * 4;
            od[o2] = od[o2 + 1] = od[o2 + 2] = v2; od[o2 + 3] = 255;
          }
        }
        // Whiten the thin border ring between the outer bbox and the inset
        // region so the badge's rounded outline doesn't confuse Tesseract.
        for (y = bb.minY; y <= bb.maxY; y++) {
          for (x = bb.minX; x <= bb.maxX; x++) {
            if (x >= rx0 && x < rx1 && y >= ry0 && y < ry1) continue;
            var o3 = (y * w + x) * 4;
            od[o3] = od[o3 + 1] = od[o3 + 2] = 255; od[o3 + 3] = 255;
          }
        }
        badgeRects.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1 });
      }

      // --- 3. Plain-text line bands: confirmed 2026-09-02 that even after
      // the adaptive threshold above, Tesseract's automatic page layout can
      // still mangle or drop the faint plain-gray lines (job number,
      // assembly ref, quantity) when reading the whole composite in one
      // pass — the exact same "isolate it and read it alone" fix that
      // works for badges also works here. Every gap above/between/below
      // the badges *in the same column* is one of these lines, so band
      // them off by column and read each band on its own.
      //
      // Only genuinely field-sized badges are used to DEFINE columns —
      // confirmed 2026-09-02 that a wide footer/barcode strip (a real badge
      // by the earlier filter, since it's a dark, mostly-solid bar) spans
      // far enough across the label to bridge the left and right columns
      // into one, which then bands the two columns' text together into a
      // single garbled crop. A genuine per-field badge on this label is
      // never anywhere near half the label's width, so that's the cutoff.
      var columnBadges = [];
      for (i = 0; i < badges.length; i++) {
        if ((badges[i].maxX - badges[i].minX + 1) < 0.5 * w) columnBadges.push(badges[i]);
      }
      var columns = []; // [{x0,x1,badges:[...]}]
      for (i = 0; i < columnBadges.length; i++) {
        var bd = columnBadges[i];
        var placedCol = -1;
        for (var c = 0; c < columns.length; c++) {
          if (bd.minX < columns[c].x1 && columns[c].x0 < bd.maxX + 1) { placedCol = c; break; }
        }
        if (placedCol === -1) { columns.push({ x0: bd.minX, x1: bd.maxX + 1, badges: [bd] }); }
        else {
          columns[placedCol].x0 = Math.min(columns[placedCol].x0, bd.minX);
          columns[placedCol].x1 = Math.max(columns[placedCol].x1, bd.maxX + 1);
          columns[placedCol].badges.push(bd);
        }
      }
      var lineBandRects = [];
      for (c = 0; c < columns.length; c++) {
        var col = columns[c];
        col.badges.sort(function (a, b3) { return a.minY - b3.minY; });
        var prevBottom = 0;
        for (var k = 0; k <= col.badges.length; k++) {
          var top = (k < col.badges.length) ? col.badges[k].minY : h;
          if (top - prevBottom > 0.015 * h) {
            var lx0 = col.x0, ly0 = prevBottom, lx1 = col.x1, ly1 = top;
            var ink = 0;
            for (y = ly0; y < ly1; y++) { for (x = lx0; x < lx1; x++) { if (od[(y * w + x) * 4] === 0) ink++; } }
            if (ink > 0.01 * (lx1 - lx0) * (ly1 - ly0)) lineBandRects.push({ x0: lx0, y0: ly0, x1: lx1, y1: ly1 });
          }
          if (k < col.badges.length) prevBottom = col.badges[k].maxY + 1;
        }
      }
      if (lineBandRects.length > 8) lineBandRects = lineBandRects.slice(0, 8);

      // Re-threshold each line band with its OWN local Otsu split, same as
      // the badges above, instead of leaving it as whatever the single
      // whole-image adaptive threshold decided. Confirmed 2026-09-02: the
      // job number line on a real photo was unreadably broken under the
      // global adaptive threshold (print density/lighting varies enough
      // line-to-line that one fixed window+constant can't fit every line)
      // but came out perfectly once given this same fresh local threshold
      // already proven on badges. Polarity is the opposite of a badge's,
      // though: here the text is DARKER than its background, not brighter.
      for (i = 0; i < lineBandRects.length; i++) {
        var lb = lineBandRects[i];
        var lt = otsuThreshold(gray, w, lb.x0, lb.y0, lb.x1, lb.y1);
        for (y = lb.y0; y < lb.y1; y++) {
          for (x = lb.x0; x < lb.x1; x++) {
            var li = y * w + x;
            var lv = gray[li] < lt ? 0 : 255; // text (darker than its own local background) -> black
            var lo = li * 4;
            od[lo] = od[lo + 1] = od[lo + 2] = lv; od[lo + 3] = 255;
          }
        }
      }

      // Commit the fully-painted composite once, then cut each region's own
      // small padded image straight out of it (so every view is pixel-for-
      // pixel identical to the composite — no separate re-render path to
      // drift out of sync).
      octx.putImageData(outImg, 0, 0);
      var pad = 10;
      function cutRegion(rct) {
        var rw = rct.x1 - rct.x0, rh = rct.y1 - rct.y0;
        var rCanvas = document.createElement('canvas');
        rCanvas.width = rw + pad * 2;
        rCanvas.height = rh + pad * 2;
        var rctx = rCanvas.getContext('2d');
        rctx.fillStyle = '#fff';
        rctx.fillRect(0, 0, rCanvas.width, rCanvas.height);
        rctx.drawImage(outCanvas, rct.x0, rct.y0, rw, rh, pad, pad, rw, rh);
        return rCanvas;
      }
      var regions = [];
      for (i = 0; i < badgeRects.length; i++) regions.push({ canvas: cutRegion(badgeRects[i]), psm: '7' });
      for (i = 0; i < lineBandRects.length; i++) regions.push({ canvas: cutRegion(lineBandRects[i]), psm: '6' });

      return { compositeCanvas: outCanvas, regions: regions };
    } catch (e) {
      return fallback;
    }
  }

  function handleDecoded(raw) {
    var parsed = parseQr(raw);
    if (!parsed) {
      // Malformed read — show it on screen (also lets the operator screenshot a real
      // scan for support), then keep scanning. Doesn't lock, doesn't stop the loop.
      state.scanErrorRaw = raw;
      renderScanError();
      clearTimeout(errorTimer);
      errorTimer = setTimeout(function () { state.scanErrorRaw = null; renderScanError(); }, 2200);
      return;
    }
    state.locked = true;
    renderScanStatus();
    var frame = captureFrameDataUrl();
    clearTimeout(lockTimer);
    lockTimer = setTimeout(function () {
      state.source = 'qr';
      state.values = parsed;
      state.rawQr = raw;
      if (frame) {
        downscaleDataUrl(frame, function (small) {
          state.photos = [{ id: 'label', label: 'Label', dataUrl: small, removable: false }];
          state.nextPhotoNum = 1;
          enterReview();
        });
      } else {
        state.photos = [];
        enterReview();
      }
    }, 550);
  }

  function renderScanStatus() {
    $('#scan-hunt').style.display = state.locked ? 'none' : '';
    $('#scan-hunt').textContent = state.mode === 'qr' ? 'Point at the QR code' : 'Frame the whole label';
    $('#scan-locked').style.display = state.locked ? '' : 'none';
    if (state.locked) $('#scan-raw').textContent = state.rawQr || '';
  }
  function renderScanError() {
    var el = $('#scan-error');
    if (state.scanErrorRaw) {
      $('#scan-error-raw').textContent = state.scanErrorRaw;
      el.classList.add('show');
    } else {
      el.classList.remove('show');
    }
  }

  // ---------------------------------------------------------------------
  // Scan screen controls
  // ---------------------------------------------------------------------
  $('#tab-qr').addEventListener('click', function () { setMode('qr'); });
  $('#tab-ocr').addEventListener('click', function () { setMode('ocr'); });
  function setMode(m) {
    state.mode = m;
    $('#tab-qr').classList.toggle('active', m === 'qr');
    $('#tab-ocr').classList.toggle('active', m === 'ocr');
    renderScanStatus();
  }

  $('#shutter-btn').addEventListener('click', function () {
    if (state.mode === 'ocr') {
      if (state.ocrBusy) return;
      var frame = captureFrameDataUrl(); // full frame — kept as the attached photo, unrelated to OCR
      if (!frame) { state.photos = []; state.ocrDebug = null; openManual(true, {}); return; }

      downscaleDataUrl(frame, function (small) {
        state.photos = [{ id: 'label', label: 'Label', dataUrl: small, removable: false }];
        state.nextPhotoNum = 1;
      });

      // OCR itself runs on a SEPARATE, cropped capture (just the on-screen guide
      // box), not the full frame above — see computeOcrCropRect()'s comment —
      // and that crop is then run through preprocessOcrCrop() (see its comment)
      // before Tesseract ever sees it: this is the fix, confirmed 2026-09-02
      // against a real label photo, for labels that mix bold white-on-black
      // "badge" text with faint plain gray text in the same image.
      var cropCanvas = captureOcrCropCanvas();
      var pre = cropCanvas ? preprocessOcrCrop(cropCanvas) : null;
      var compositeCanvas = pre && pre.compositeCanvas;
      var ocrRegions = (pre && pre.regions) || [];
      // What "What OCR saw" shows — the normalized image actually handed to
      // Tesseract, not the raw photo, so the debug panel reflects reality.
      var debugImageSrc = (compositeCanvas && compositeCanvas.toDataURL('image/png'))
        || (cropCanvas && cropCanvas.toDataURL('image/jpeg', 0.9)) || frame;

      state.ocrBusy = true;
      $('#shutter-btn').disabled = true;
      $('#scan-hunt').textContent = 'Reading label…';
      var worker;
      getOcrWorker()
        .then(function (w) {
          worker = w;
          // Worker's PSM is already '3' (automatic) from getOcrWorker() — right
          // setting for one pass over the whole normalized label.
          return worker.recognize(compositeCanvas ? compositeCanvas.toDataURL('image/png') : debugImageSrc);
        })
        .then(function (compositeResult) {
          var compositeText = (compositeResult && compositeResult.data && compositeResult.data.text) || '';
          if (!ocrRegions.length) return [compositeText];
          // Re-read each badge/line-band region on its own (in the PSM mode
          // preprocessOcrCrop picked for it) — confirmed 2026-09-02: Tesseract
          // reads one clean isolated field far more reliably than the same
          // text embedded in a whole busy label.
          return ocrRegions.reduce(function (chain, region) {
            return chain.then(function (acc) {
              return worker.setParameters({ tessedit_pageseg_mode: region.psm }).then(function () {
                return worker.recognize(region.canvas.toDataURL('image/png'));
              }).then(function (r) {
                acc.push((r && r.data && r.data.text) || '');
                return acc;
              });
            });
          }, Promise.resolve([compositeText])).then(function (texts) {
            // Reset for the next capture, whatever mode this one ends in.
            return worker.setParameters({ tessedit_pageseg_mode: '3' }).then(function () { return texts; });
          });
        })
        .then(function (texts) {
          var rawText = texts.join('\n');
          var guesses = guessFieldsFromOcrText(rawText);
          // Downscale ONLY the debug-preview copy — a real camera's native crop can be
          // several MB as a data URL, which some phones' browsers appear to choke on
          // when set as an <img src> (confirmed 2026-09-02: everything after that image
          // in the panel silently failed to render on a real device). OCR itself still
          // ran on the full-resolution images above, unaffected by this.
          downscaleDataUrl(debugImageSrc, function (smallImg) {
            state.ocrDebug = { image: smallImg, text: rawText };
            state.ocrBusy = false;
            $('#shutter-btn').disabled = false;
            openManual(true, guesses);
          });
        })
        .catch(function (err) {
          // OCR failed to load or run (e.g. first-time fetch of the engine files
          // failed) — fall back to a plain blank manual entry rather than getting stuck.
          // Still record what was attempted so "What OCR saw" can show the real error
          // instead of silently leaving the operator with an unexplained blank form.
          downscaleDataUrl(debugImageSrc, function (smallImg) {
            state.ocrDebug = { image: smallImg, text: '(OCR did not run: ' + ((err && err.message) || err || 'unknown error') + ')' };
            state.ocrBusy = false;
            $('#shutter-btn').disabled = false;
            openManual(true, {});
          });
        });
    } else {
      // Force an immediate decode attempt from the current frame.
      if (video.videoWidth) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = window.jsQR(imgData.data, imgData.width, imgData.height);
        if (code && code.data) handleDecoded(code.data);
      }
    }
  });

  $('#manual-link').addEventListener('click', function () { openManual(false); });
  $('#camera-retry-btn').addEventListener('click', startCamera);
  $('#camera-manual-fallback').addEventListener('click', function () { openManual(false); });

  // ---------------------------------------------------------------------
  // Manual entry screen
  // ---------------------------------------------------------------------
  function openManual(fromOcr, guesses) {
    guesses = guesses || {};
    state.manualInfoBanner = !!fromOcr;
    if (fromOcr) {
      var hasAnyGuess = VALUE_FIELDS.some(function (id) { return guesses[id]; });
      $('#manual-info-banner').textContent = hasAnyGuess
        ? 'Read from the photo — check each value below before continuing.'
        : "Couldn't confidently read the label from that photo — enter the values below.";
    } else {
      state.ocrDebug = null; // plain manual entry — nothing to show
    }
    $('#manual-info-banner').style.display = fromOcr ? '' : 'none';
    $('#m-job').value = guesses.job || '';
    $('#m-mfg').value = guesses.mfg || '';
    $('#m-assy').value = guesses.assy || '';
    $('#m-part').value = guesses.part || '';
    $('#m-qty').value = guesses.qty || '';
    renderOcrDebug();
    checkManualComplete();
    showScreen('manual');
  }
  // "What OCR saw" — shows the operator exactly what was sent to the OCR engine
  // (the cropped image) and exactly what it read back (the raw text), so a bad
  // read can be diagnosed on the phone itself instead of by sending photos back
  // and forth. Collapsed by default; only shown after an actual OCR attempt.
  function renderOcrDebug() {
    var panel = $('#ocr-debug');
    if (!state.ocrDebug) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    $('#ocr-debug-body').style.display = 'none';
    $('#ocr-debug-toggle').textContent = 'What OCR saw ▾';

    var img = state.ocrDebug.image || '';
    var text = state.ocrDebug.text || '';
    // A plain text line, set first and independent of the <img>/<pre> below —
    // confirmed 2026-09-02 on a real phone that the image and text below this
    // point sometimes don't render at all (likely a large data URL choking
    // that browser). This line uses only textContent on a plain div, so it
    // stays visible even if the image/pre rendering fails outright, and it's
    // useful on its own: sizes + a preview of what was actually recognized.
    var preview = text ? '"' + text.trim().slice(0, 80).replace(/\n/g, ' / ') + (text.trim().length > 80 ? '…' : '') + '"' : '(no text at all)';
    $('#ocr-debug-diag').textContent = 'image: ' + img.length + ' chars · text: ' + text.length + ' chars · ' + preview;

    try { $('#ocr-debug-image').src = img; }
    catch (e) { $('#ocr-debug-diag').textContent += ' [image render error: ' + e.message + ']'; }

    try { $('#ocr-debug-text').textContent = text.trim() || '(empty — the OCR engine found no text at all in that image)'; }
    catch (e) { $('#ocr-debug-diag').textContent += ' [text render error: ' + e.message + ']'; }
  }
  $('#ocr-debug-toggle').addEventListener('click', function () {
    var body = $('#ocr-debug-body');
    var open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    $('#ocr-debug-toggle').textContent = 'What OCR saw ' + (open ? '▾' : '▴');
  });
  function checkManualComplete() {
    var ok = ['#m-job', '#m-mfg', '#m-assy', '#m-part', '#m-qty'].every(function (sel) { return $(sel).value.trim().length > 0; });
    $('#manual-continue-btn').disabled = !ok;
  }
  ['#m-job', '#m-mfg', '#m-assy', '#m-part', '#m-qty'].forEach(function (sel) {
    $(sel).addEventListener('input', checkManualComplete);
  });
  $('#manual-back-btn').addEventListener('click', goScan);
  $('#manual-continue-btn').addEventListener('click', function () {
    state.source = 'manual';
    state.rawQr = null;
    state.values = {
      job: $('#m-job').value.trim(), mfg: $('#m-mfg').value.trim(),
      assy: $('#m-assy').value.trim(), part: $('#m-part').value.trim(),
      qty: $('#m-qty').value.trim(),
    };
    // A manually-entered report has no camera photo unless one was captured via the
    // OCR shutter step (already sitting in state.photos in that case).
    if (!state.photos.length) state.nextPhotoNum = 1;
    enterReview();
  });

  // ---------------------------------------------------------------------
  // Review screen
  // ---------------------------------------------------------------------
  function enterReview() {
    state.locked = false;
    state.editingField = null;
    state.target = 'part';
    state.note = '';
    state.summaryExtra = '';
    // No default reason — the operator must actively pick one (or leave all
    // deselected and just type a note instead). Previously this defaulted to
    // the top-ordered reason, which meant there was no way to fall back to
    // free-typed text without a reason silently staying selected underneath.
    state.kind = null;
    state.busena = null;
    state.bukle = null;
    // Auto-fill from the scan when the label includes a 5th (quantity) field;
    // otherwise starts blank, same as manual entry.
    state.qtyTotal = (state.values && state.values.qty) ? String(state.values.qty) : '';
    state.qtyChoice = null;
    state.qtyOther = '';
    state.showPayload = false;
    renderReview();
    showScreen('review');
  }

  function fieldsFilledCount() {
    if (!state.values) return 0;
    return VALUE_FIELDS.filter(function (id) { return (state.values[id] || '').trim().length; }).length;
  }

  function renderReview() {
    var v = state.values || { job: '', mfg: '', assy: '', part: '' };
    var sourceIsQr = state.source === 'qr';

    $('#review-source-note').textContent = sourceIsQr ? ('QR · ' + VALUE_FIELDS.length + ' fields read') : 'Manual entry';
    $('#fields-card-title').textContent = sourceIsQr ? 'From the QR code' : 'Entered manually';
    var filled = fieldsFilledCount();
    var badge = $('#fields-badge');
    badge.textContent = filled + ' / ' + VALUE_FIELDS.length + ' fields';
    badge.className = 'badge-count ' + (filled === VALUE_FIELDS.length ? 'ok' : 'neutral');

    $('#fields-list').innerHTML = VALUE_FIELDS.map(function (id) {
      var editing = state.editingField === id;
      var badgeClass = sourceIsQr ? 'qr' : 'manual';
      var badgeText = sourceIsQr ? 'QR' : 'MANUAL';
      var val = esc(v[id] || '');
      return '<div class="field-row">' +
        '<div class="flabel">' + esc(LABELS[id]) + '</div>' +
        '<div class="fval-wrap">' +
        (editing
          ? '<input data-field-input="' + id + '" value="' + val + '" autofocus>'
          : '<button class="fval-btn" data-field-tap="' + id + '">' + (val || '<span style="color:#9CA3AF">(empty)</span>') + '</button>' +
            '<span class="field-badge ' + badgeClass + '">' + badgeText + '</span>')
        + '</div></div>';
    }).join('');

    $('#raw-row').textContent = state.rawQr ? state.rawQr : '(entered manually — no raw QR string)';

    var subassyCode = deriveSubassembly(v.part);
    if (state.target === 'subassy' && !subassyCode) state.target = 'part'; // was selected, no longer derivable
    var targets = [{ id: 'assy', kind: 'Assembly', code: v.assy }];
    if (subassyCode) targets.push({ id: 'subassy', kind: 'Subassembly', code: subassyCode });
    targets.push({ id: 'part', kind: 'Part', code: v.part });

    $('#target-row').classList.toggle('has-three', targets.length === 3);
    $('#target-row').innerHTML = targets.map(function (t) {
      var sel = state.target === t.id;
      return '<button class="target-btn' + (sel ? ' selected' : '') + '" data-target="' + t.id + '">' +
        '<span class="t-kind">' + esc(t.kind) + '</span><span class="t-code">' + esc(t.code || '—') + '</span></button>';
    }).join('');

    renderPhotos();
    renderReasonChips();
    renderChoiceRow('#busena-row', BUSENA_OPTIONS, state.busena, 'busena');
    renderChoiceRow('#bukle-row', BUKLE_OPTIONS, state.bukle, 'bukle');
    renderQty();

    if ($('#summary-extra-input').value !== state.summaryExtra) $('#summary-extra-input').value = state.summaryExtra;
    $('#note-input').value = state.note;
    $('#payload-pre').textContent = payloadText();
    $('#payload-toggle-btn').textContent = state.showPayload ? 'Hide request body' : 'Show request body';
    $('#payload-pre').classList.toggle('show', state.showPayload);

    var errBanner = $('#qr-error-banner');
    var missing = [];
    if (filled < VALUE_FIELDS.length) missing.push('fill in the empty fields');
    if (!state.busena) missing.push('choose Būsena');
    if (!state.bukle) missing.push('choose Būklė');
    if (missing.length) {
      errBanner.textContent = 'Before creating the issue: ' + missing.join(', ') + '.';
      errBanner.classList.add('show');
    } else {
      errBanner.classList.remove('show');
    }
    $('#submit-btn').disabled = state.posting || filled < VALUE_FIELDS.length || !state.busena || !state.bukle;

    renderLibrary();
  }

  function renderChoiceRow(containerSel, options, current, attr) {
    $(containerSel).innerHTML = options.map(function (opt) {
      var sel = current === opt;
      return '<button class="choice-chip' + (sel ? ' selected' : '') + '" data-' + attr + '="' + esc(opt) + '">' + esc(opt) + '</button>';
    }).join('');
  }

  // Quantity: QR doesn't carry a quantity value yet (confirmed 2026-08-27), so "total on
  // label" is operator-typed here. Once real scanned data includes it, this same total can
  // be auto-filled from parseQr() instead — the 1 / All / Other chooser doesn't need to change.
  function renderQty() {
    if ($('#qty-total-input').value !== state.qtyTotal) $('#qty-total-input').value = state.qtyTotal;
    var total = (state.qtyTotal || '').trim();
    if (state.qtyChoice === 'all' && !total) state.qtyChoice = null; // total cleared — selection no longer valid
    var options = [
      { id: '1', label: '1' },
      { id: 'all', label: total ? ('All (' + total + ')') : 'All', disabled: !total },
      { id: 'other', label: 'Other' },
    ];
    $('#qty-choice-row').innerHTML = options.map(function (o) {
      var sel = state.qtyChoice === o.id;
      return '<button class="choice-chip' + (sel ? ' selected' : '') + '"' + (o.disabled ? ' disabled' : '') +
        ' data-qty-choice="' + o.id + '">' + esc(o.label) + '</button>';
    }).join('');
    $('#qty-other-wrap').style.display = state.qtyChoice === 'other' ? '' : 'none';
    if ($('#qty-other-input').value !== state.qtyOther) $('#qty-other-input').value = state.qtyOther;
  }

  function resolvedQty() {
    if (state.qtyChoice === '1') return '1';
    if (state.qtyChoice === 'all') return (state.qtyTotal || '').trim() || null;
    if (state.qtyChoice === 'other') return (state.qtyOther || '').trim() || null;
    return null;
  }

  function renderPhotos() {
    $('#photo-count-badge').textContent = state.photos.length + ' / ' + MAX_PHOTOS;
    var tiles = state.photos.map(function (p) {
      return '<div class="photo-tile">' +
        '<img src="' + p.dataUrl + '" alt="">' +
        '<span class="p-label">' + esc(p.label) + '</span>' +
        (p.removable ? '<button class="p-remove" data-remove-photo="' + p.id + '">&#215;</button>' : '') +
        '</div>';
    }).join('');
    var addTile = state.photos.length < MAX_PHOTOS
      ? '<button type="button" class="photo-add" id="photo-add-tile"><span class="plus">+</span>Photo</button>' : '';
    $('#photos-grid').innerHTML = tiles + addTile;
  }

  function renderReasonChips() {
    var ordered = orderedReasons();
    var chips = ordered.map(function (name) {
      var sel = state.kind === name;
      return '<button class="reason-chip' + (sel ? ' selected' : '') + '" data-reason="' + esc(name) + '">' + esc(name) + '</button>';
    }).join('');
    $('#reason-chips').innerHTML = chips + '<button class="reason-chip new-chip" id="reason-new-chip">+ New</button>';
  }

  function renderLibrary() {
    $('#library-list').innerHTML = orderedReasons().map(function (name) {
      var isCustom = state.custom.indexOf(name) !== -1;
      return '<div class="sheet-row">' +
        '<span class="r-name">' + esc(name) + '</span>' +
        '<span class="r-tag ' + (isCustom ? 'custom' : 'default') + '">' + (isCustom ? 'Added here' : 'Default') + '</span>' +
        '<button class="r-remove" data-remove-reason="' + esc(name) + '">&#215;</button>' +
        '</div>';
    }).join('');
  }

  // -- event delegation for the review screen --
  var reviewBody = $('#screen-review');
  delegate(reviewBody, '[data-field-tap]', 'click', function (el) {
    state.editingField = el.getAttribute('data-field-tap');
    renderReview();
    var input = $('[data-field-input="' + state.editingField + '"]');
    if (input) { input.focus(); input.select(); }
  });
  reviewBody.addEventListener('blur', function (e) {
    if (e.target.matches('[data-field-input]')) {
      var id = e.target.getAttribute('data-field-input');
      state.values[id] = e.target.value;
      // Keep the Quantity card's "Total on label" in sync if the operator
      // corrects the scanned/typed quantity up here after the fact.
      if (id === 'qty') state.qtyTotal = e.target.value;
      state.editingField = null;
      renderReview();
    }
  }, true);
  reviewBody.addEventListener('keydown', function (e) {
    if (e.target.matches('[data-field-input]') && e.key === 'Enter') e.target.blur();
  });
  delegate(reviewBody, '[data-target]', 'click', function (el) {
    state.target = el.getAttribute('data-target');
    renderReview();
  });
  delegate(reviewBody, '[data-busena]', 'click', function (el) {
    state.busena = el.getAttribute('data-busena');
    renderReview();
  });
  delegate(reviewBody, '[data-bukle]', 'click', function (el) {
    state.bukle = el.getAttribute('data-bukle');
    renderReview();
  });
  delegate(reviewBody, '[data-qty-choice]', 'click', function (el) {
    if (el.disabled) return;
    state.qtyChoice = el.getAttribute('data-qty-choice');
    renderQty();
    $('#payload-pre').textContent = payloadText();
  });
  delegate(reviewBody, '#photo-add-tile', 'click', function () { $('#photo-input').click(); });
  delegate(reviewBody, '[data-remove-photo]', 'click', function (el) {
    var id = el.getAttribute('data-remove-photo');
    state.photos = state.photos.filter(function (p) { return p.id !== id; });
    renderPhotos();
  });
  delegate(reviewBody, '[data-reason]', 'click', function (el) {
    var name = el.getAttribute('data-reason');
    state.kind = (state.kind === name) ? null : name; // tap a selected chip again to clear it
    renderReasonChips();
    $('#payload-pre').textContent = payloadText();
  });
  delegate(reviewBody, '#reason-new-chip', 'click', function () { openLibrary(); });
  delegate(reviewBody, '[data-remove-reason]', 'click', function (el) {
    var name = el.getAttribute('data-remove-reason');
    state.reasons = state.reasons.filter(function (r) { return r !== name; });
    state.custom = state.custom.filter(function (r) { return r !== name; });
    persistReasons();
    if (state.kind === name) state.kind = orderedReasons()[0] || null;
    renderLibrary();
    renderReasonChips();
  });

  $('#photo-input').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || state.photos.length >= MAX_PHOTOS) return;
    var reader = new FileReader();
    reader.onload = function () {
      downscaleDataUrl(reader.result, function (small) {
        var n = state.nextPhotoNum++;
        state.photos.push({ id: 'p' + n, label: 'Defect ' + n, dataUrl: small, removable: true });
        renderPhotos();
      });
    };
    reader.readAsDataURL(file);
  });

  $('#note-input').addEventListener('input', function (e) { state.note = e.target.value; $('#payload-pre').textContent = payloadText(); });
  $('#summary-extra-input').addEventListener('input', function (e) { state.summaryExtra = e.target.value; $('#payload-pre').textContent = payloadText(); });
  $('#qty-total-input').addEventListener('input', function (e) {
    state.qtyTotal = e.target.value;
    renderQty();
    $('#payload-pre').textContent = payloadText();
  });
  $('#qty-other-input').addEventListener('input', function (e) { state.qtyOther = e.target.value; $('#payload-pre').textContent = payloadText(); });
  $('#payload-toggle-btn').addEventListener('click', function () {
    state.showPayload = !state.showPayload;
    $('#payload-toggle-btn').textContent = state.showPayload ? 'Hide request body' : 'Show request body';
    $('#payload-pre').classList.toggle('show', state.showPayload);
  });

  $('#review-back-btn').addEventListener('click', goScan);

  function openLibrary() {
    state.libraryOpen = true;
    state.draft = '';
    $('#reason-draft-input').value = '';
    renderLibrary();
    $('#library-sheet-backdrop').classList.add('show');
  }
  function closeLibrary() {
    state.libraryOpen = false;
    $('#library-sheet-backdrop').classList.remove('show');
    renderReasonChips();
  }
  $('#open-library-btn').addEventListener('click', openLibrary);
  $('#close-library-btn').addEventListener('click', closeLibrary);
  $('#add-reason-btn').addEventListener('click', function () {
    var name = $('#reason-draft-input').value.trim();
    $('#reason-draft-input').value = '';
    if (!name || state.reasons.indexOf(name) !== -1) return;
    state.reasons.push(name);
    state.custom.push(name);
    persistReasons();
    state.kind = name;
    renderLibrary();
    renderReasonChips();
  });
  $('#reason-draft-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#add-reason-btn').click();
  });

  // ---------------------------------------------------------------------
  // Subassembly derivation — a pattern spotted from a real scanned label:
  // part "26-29819-01.00.01_A" -> assembly "26-29819-01.00.00 SB_A" on that
  // same label. Generalized: drop the part number's final dot-segment and
  // append ".00 SB_A". Confirmed against exactly two real examples so far —
  // worth double-checking with whoever owns Novameta's part-numbering
  // scheme before this feeds a real submitted ticket, but safe to offer
  // as a selectable option here since it's just hidden when it can't be
  // derived.
  // ---------------------------------------------------------------------
  function deriveSubassembly(part) {
    var p = (part || '').trim();
    var idx = p.lastIndexOf('.');
    if (idx < 1) return null; // no dot (or dot is the very first char) — not derivable
    var base = p.slice(0, idx);
    if (!base) return null;
    return base + '.00 SB_A';
  }

  // ---------------------------------------------------------------------
  // Payload — the exact request body the design spec shows (slide 6 / mock)
  // ---------------------------------------------------------------------
  var TARGET_WORDS = { assy: 'Assembly', subassy: 'Subassembly', part: 'Part' };
  function targetCode() {
    if (!state.values) return '';
    if (state.target === 'part') return state.values.part;
    if (state.target === 'subassy') return deriveSubassembly(state.values.part) || '';
    return state.values.assy;
  }
  // Summary: "Job;Mfg;AssemblyOrPart" plus optional operator words, per spec 2026-08-27.
  function summaryText() {
    var v = state.values || { job: '', mfg: '', assy: '', part: '' };
    var core = [v.job, v.mfg, targetCode()].join(';');
    var extra = (state.summaryExtra || '').trim();
    return extra ? (core + ' - ' + extra) : core;
  }
  // Description: the selected defect reason if one was chosen; otherwise whatever the
  // operator typed in the note. No recap line — the Job/Mfg/Assembly/Part values are
  // already carried structurally in customFields below, so nothing is lost.
  function descriptionText() {
    if (state.kind) return state.kind;
    var note = (state.note || '').trim();
    return note || '(no description)';
  }
  function payloadText() {
    var v = state.values || { job: '', mfg: '', assy: '', part: '' };
    var qty = resolvedQty();
    var body = {
      project: { id: '0-12' },
      summary: summaryText(),
      description: descriptionText(),
      customFields: [
        { name: 'Job number', $type: 'SimpleIssueCustomField', value: v.job },
        { name: 'Manufacturing code', $type: 'SimpleIssueCustomField', value: v.mfg },
        { name: 'Assembly', $type: 'SimpleIssueCustomField', value: v.assy },
        { name: 'Part number', $type: 'SimpleIssueCustomField', value: v.part },
        { name: 'Defect reason', $type: 'SingleEnumIssueCustomField', value: { name: state.kind } },
        { name: 'Būsena', $type: 'StateIssueCustomField', value: state.busena ? { name: state.busena } : null },
        { name: 'Būklė', $type: 'SingleEnumIssueCustomField', value: state.bukle ? { name: state.bukle } : null },
        { name: 'Brokas (vnt/kg/vmz.vnt)', $type: 'SimpleIssueCustomField', value: qty },
      ],
    };
    return JSON.stringify(body, null, 2);
  }

  // ---------------------------------------------------------------------
  // Submit — SIMULATED. Real wiring is a later, separate step (needs a
  // YouTrack project id, confirmed custom fields, and an auth strategy).
  // ---------------------------------------------------------------------
  $('#submit-btn').addEventListener('click', function () {
    if (state.posting || fieldsFilledCount() < VALUE_FIELDS.length) return;
    state.posting = true;
    if (state.kind) bumpUsage(state.kind);
    showScreen('posting');
    state.postStage = 'POST /api/issues';
    $('#post-stage').textContent = state.postStage;
    setTimeout(function () {
      state.postStage = 'Uploading ' + state.photos.length + ' photo' + (state.photos.length === 1 ? '' : 's');
      $('#post-stage').textContent = state.postStage;
      setTimeout(function () {
        state.issueKey = 'NM-' + state.nextKey;
        state.nextKey += 1;
        state.posting = false;
        renderDone();
        showScreen('done');
      }, 1000);
    }, 900);
  });

  function renderDone() {
    $('#done-summary').textContent = 'Job ' + state.values.job + ' · ' + targetCode() + ' · ' +
      state.photos.length + ' photo' + (state.photos.length === 1 ? '' : 's') + ' attached.';
    $('#done-key').textContent = state.issueKey;
    $('#mock-note').classList.remove('show');
  }
  $('#scan-next-btn').addEventListener('click', goScan);
  // Fixes the mockup's bug where "Open in YouTrack" silently re-triggered "scan next".
  // There's no real ticket yet (submission is simulated) — say so instead of doing nothing.
  $('#open-youtrack-btn').addEventListener('click', function () {
    $('#mock-note').classList.add('show');
  });

  // ---------------------------------------------------------------------
  // Reset to a fresh scan
  // ---------------------------------------------------------------------
  function goScan() {
    clearTimeout(lockTimer); clearTimeout(errorTimer);
    state.locked = false;
    state.mode = 'qr';
    state.scanErrorRaw = null;
    state.source = null; state.values = null; state.rawQr = null; state.editingField = null;
    state.target = 'part'; state.note = ''; state.summaryExtra = '';
    state.busena = null; state.bukle = null;
    state.qtyTotal = ''; state.qtyChoice = null; state.qtyOther = '';
    state.showPayload = false;
    state.photos = []; state.nextPhotoNum = 1;
    state.libraryOpen = false; state.draft = '';
    setMode('qr');
    renderScanStatus();
    renderScanError();
    showScreen('scan');
  }

  // Exposes a couple of internal OCR functions on window, ONLY when a test
  // harness sets window.__OCR_TEST_HOOKS__ = true before this file loads.
  // No normal page load ever sets that flag, so this is a no-op for every
  // real user — it exists purely so automated tests can exercise the real
  // preprocessing/guessing code directly (pixel work needs an actual
  // browser canvas, which is why this can't just be unit-tested in Node).
  if (window.__OCR_TEST_HOOKS__) {
    window.__ocrTestHooks = {
      preprocessOcrCrop: preprocessOcrCrop,
      guessFieldsFromOcrText: guessFieldsFromOcrText,
      getOcrWorker: getOcrWorker,
    };
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  loadReasons();
  startCamera();
  renderScanStatus();
  $('#build-version').textContent = APP_VERSION;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline caching is a nice-to-have */ });
  }
})();
