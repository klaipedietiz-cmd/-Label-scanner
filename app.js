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
  var LABELS = { job: 'Job number', mfg: 'Manuf. code', assy: 'Assembly', part: 'Part no.' };
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
    manualInfoBanner: false,  // show the "OCR isn't available" note on the manual screen
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
  // QR payload parsing — "%job;mfg;assy;part%" (4 slots) or
  // "%job;mfg;assy;part;qty%" (5 slots, quantity appended — confirmed
  // 2026-08-27 from a real scanned label: "%010127-1-1;10-D1-61;
  // 26-29719-01.00.00 SB_A;26-29719-01.10.02_A;5%"). Both are accepted so
  // older 4-field labels keep working.
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
    if (parts.length !== 4 && parts.length !== 5) return null;
    return {
      job: parts[0], mfg: parts[1], assy: parts[2], part: parts[3],
      qty: parts.length === 5 ? parts[4] : null,
    };
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
      // OCR isn't implemented — capture the label photo and hand off to manual entry.
      var frame = captureFrameDataUrl();
      if (frame) {
        downscaleDataUrl(frame, function (small) {
          state.photos = [{ id: 'label', label: 'Label', dataUrl: small, removable: false }];
          state.nextPhotoNum = 1;
          openManual(true);
        });
      } else {
        state.photos = [];
        openManual(true);
      }
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
  function openManual(fromOcr) {
    state.manualInfoBanner = !!fromOcr;
    $('#manual-info-banner').style.display = fromOcr ? '' : 'none';
    $('#m-job').value = ''; $('#m-mfg').value = ''; $('#m-assy').value = ''; $('#m-part').value = '';
    checkManualComplete();
    showScreen('manual');
  }
  function checkManualComplete() {
    var ok = ['#m-job', '#m-mfg', '#m-assy', '#m-part'].every(function (sel) { return $(sel).value.trim().length > 0; });
    $('#manual-continue-btn').disabled = !ok;
  }
  ['#m-job', '#m-mfg', '#m-assy', '#m-part'].forEach(function (sel) {
    $(sel).addEventListener('input', checkManualComplete);
  });
  $('#manual-back-btn').addEventListener('click', goScan);
  $('#manual-continue-btn').addEventListener('click', function () {
    state.source = 'manual';
    state.rawQr = null;
    state.values = {
      job: $('#m-job').value.trim(), mfg: $('#m-mfg').value.trim(),
      assy: $('#m-assy').value.trim(), part: $('#m-part').value.trim(),
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
    return ['job', 'mfg', 'assy', 'part'].filter(function (id) { return (state.values[id] || '').trim().length; }).length;
  }

  function renderReview() {
    var v = state.values || { job: '', mfg: '', assy: '', part: '' };
    var sourceIsQr = state.source === 'qr';

    $('#review-source-note').textContent = sourceIsQr ? 'QR · 4 fields read' : 'Manual entry';
    $('#fields-card-title').textContent = sourceIsQr ? 'From the QR code' : 'Entered manually';
    var filled = fieldsFilledCount();
    var badge = $('#fields-badge');
    badge.textContent = filled + ' / 4 fields';
    badge.className = 'badge-count ' + (filled === 4 ? 'ok' : 'neutral');

    $('#fields-list').innerHTML = ['job', 'mfg', 'assy', 'part'].map(function (id) {
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
    if (filled < 4) missing.push('fill in the empty fields');
    if (!state.busena) missing.push('choose Būsena');
    if (!state.bukle) missing.push('choose Būklė');
    if (missing.length) {
      errBanner.textContent = 'Before creating the issue: ' + missing.join(', ') + '.';
      errBanner.classList.add('show');
    } else {
      errBanner.classList.remove('show');
    }
    $('#submit-btn').disabled = state.posting || filled < 4 || !state.busena || !state.bukle;

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
    if (state.posting || fieldsFilledCount() < 4) return;
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

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  loadReasons();
  startCamera();
  renderScanStatus();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline caching is a nice-to-have */ });
  }
})();
