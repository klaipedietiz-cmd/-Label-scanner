const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  LevelFormat, convertInchesToTwip, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
} = require('docx');

const ORANGE = 'D97757';
const DARK = '1C1C1E';
const MUTED = '4B5563';
const HEADER_BG = 'F9F8F5';

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 120 },
    children: [new TextRun({ text, bold: true, color: DARK, size: 28 })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true, color: ORANGE, size: 24 })],
  });
}
function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, color: opts.color || DARK, italics: !!opts.italic, bold: !!opts.bold, size: 21 })],
  });
}
function bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { after: 60 },
    children: [new TextRun({ text, color: DARK, size: 21 })],
  });
}
function mono(text) {
  return new Paragraph({
    spacing: { after: 140 },
    indent: { left: convertInchesToTwip(0.25) },
    children: [new TextRun({ text, font: 'Courier New', color: '1C1C1E', size: 20 })],
  });
}
function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.width || 33, type: WidthType.PERCENTAGE },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: HEADER_BG } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.header, color: opts.header ? DARK : MUTED, size: 20 })] })],
  });
}
function table(headerRow, rows, widths) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    rows: [
      new TableRow({ children: headerRow.map((t, i) => cell(t, { header: true, width: widths[i] / 90 })) }),
      ...rows.map((r) => new TableRow({ children: r.map((t, i) => cell(t, { width: widths[i] / 90 })) })),
    ],
  });
}

const doc = new Document({
  numbering: {
    config: [{
      reference: 'bullets',
      levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.25) } } } }],
    }],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } },
    children: [
      new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: 'Runbook: Deploy "Label Scanner" to an internal server', bold: true, color: ORANGE, size: 32 })] }),
      p('Owner: IT / internal web hosting  ·  Frequency: as needed (one-time setup, then whenever the app is updated)  ·  Status: test build — YouTrack connection not yet wired to a real project', { italic: true, color: MUTED }),

      h1('Purpose'),
      p('Host the "Label Scanner" web app on a Novameta-controlled server so it has a permanent, private address that shop-floor phones can open, with valid HTTPS so the camera works. This replaces the temporary public GitHub Pages link used for early testing.'),

      h1('What is being deployed'),
      p('Nine static files — no database, no install, no server-side code required for this version:'),
      bullet('index.html, app.js, styles.css, jsQR.js, manifest.json, sw.js'),
      bullet('icons/icon-192.png, icons/icon-512.png'),
      p('Total size is under 100 KB. Any web server capable of serving plain files can host this.'),

      h1('Prerequisites'),
      bullet('Admin access to an internal web server (Windows Server + IIS, or Linux + Nginx/Apache)'),
      bullet('Ability to create an internal DNS record, e.g. scanner.novameta.lt'),
      bullet('Ability to obtain an HTTPS certificate for that hostname (internal CA, or a public certificate via a DNS challenge)'),
      bullet('The app files (provided as label-scanner-app.zip)'),

      h1('Procedure'),

      h2('Step 1 — Choose the hostname'),
      p('Decide on an internal address, e.g. scanner.novameta.lt. This does not need to be reachable from outside the building.'),
      p('Expected result: a hostname agreed on before continuing.', { color: MUTED, italic: true }),

      h2('Step 2 — Create the DNS record'),
      p('Add an internal DNS A or CNAME record pointing that hostname at the server that will host the files.'),
      p('Expected result: the hostname resolves to the server on the internal network.', { color: MUTED, italic: true }),
      p('If it fails: confirm with whoever manages internal DNS; some networks require a change request even for internal-only records.', { color: MUTED }),

      h2('Step 3 — Obtain an HTTPS certificate'),
      p('Camera access from the phone browser requires a valid certificate — this step cannot be skipped or deferred.'),
      bullet('Option A: issue one from Novameta\u2019s internal certificate authority, if company devices already trust it.'),
      bullet('Option B: obtain a public certificate (e.g. via Let\u2019s Encrypt) using a DNS-01 challenge — this works even though the site itself is not internet-reachable, because ownership is proven through DNS rather than a live HTTP check.'),
      p('Expected result: a certificate + private key file for scanner.novameta.lt.', { color: MUTED, italic: true }),

      h2('Step 4a — If the server is Windows Server (IIS)'),
      mono('1. Open IIS Manager -> Sites -> Add Website\n2. Site name: Label Scanner\n3. Physical path: C:\\inetpub\\wwwroot\\scanner  (create this folder first)\n4. Binding: https, port 443, host name scanner.novameta.lt\n5. SSL certificate: select the certificate imported in Step 3\n6. Copy all 9 app files into C:\\inetpub\\wwwroot\\scanner, preserving the icons subfolder'),
      p('Expected result: the site starts without errors in IIS Manager.', { color: MUTED, italic: true }),
      p('If it fails: check that the certificate was imported into the server\u2019s certificate store (not just saved as a file) before binding it in IIS.', { color: MUTED }),

      h2('Step 4b — If the server is Linux (Nginx)'),
      mono('1. sudo mkdir -p /var/www/scanner\n2. Copy all 9 app files into /var/www/scanner, preserving the icons subfolder\n3. Create /etc/nginx/sites-available/scanner with a server block:\n   server {\n     listen 443 ssl;\n     server_name scanner.novameta.lt;\n     ssl_certificate     /path/to/cert.pem;\n     ssl_certificate_key /path/to/key.pem;\n     root /var/www/scanner;\n     index index.html;\n   }\n4. sudo ln -s /etc/nginx/sites-available/scanner /etc/nginx/sites-enabled/\n5. sudo nginx -t\n6. sudo systemctl reload nginx'),
      p('Expected result: "nginx -t" reports "syntax is ok" / "test is successful" before reloading.', { color: MUTED, italic: true }),
      p('If it fails: a failed "nginx -t" almost always names the exact file and line — fix that before reloading, or Nginx will keep running the old config.', { color: MUTED }),

      h2('Step 5 — Verify from a phone'),
      p('On a phone connected to the normal company network, open https://scanner.novameta.lt directly in the browser (not from a downloaded file). Confirm the scan screen loads with correct styling and the browser prompts for camera access.'),
      p('Expected result: camera permission prompt appears; after allowing it, pointing at a label attempts to scan.', { color: MUTED, italic: true }),

      h1('Verification checklist'),
      bullet('Page loads with full styling (not plain unstyled text)'),
      bullet('Browser shows a padlock / secure connection indicator, no certificate warning'),
      bullet('Camera permission prompt appears and, once allowed, the live camera feed shows behind the scan frame'),
      bullet('"Enter manually" \u2192 fill 4 fields \u2192 Review \u2192 Create issue in YouTrack \u2192 Done screen all work'),
      bullet('"Add to Home Screen" (phone browser menu) creates a working icon'),

      h1('Troubleshooting'),
      table(
        ['Symptom', 'Likely cause', 'Fix'],
        [
          ['Certificate warning in browser', 'Certificate not trusted by the phone, or wrong hostname on the cert', 'Confirm the cert\u2019s "Common Name" / SAN exactly matches scanner.novameta.lt; push the internal CA\u2019s root cert to company devices if using Option A'],
          ['Page loads unstyled / blank', 'Files copied without the icons subfolder, or wrong physical path in the site config', 'Confirm folder structure matches the zip exactly, including icons/'],
          ['Camera never prompts', 'Site is being served over plain http, not https', 'Re-check the site binding / server block is actually on port 443 with the certificate attached'],
          ['Phone shows an old version after an update', 'The service worker (sw.js) cached the previous files', 'Close and reopen the browser tab fully, or clear the site\u2019s cache once; future updates will refresh automatically'],
          ['manifest.json or icons fail to load only', 'Server not serving .json/.png with correct MIME type (rare, some locked-down IIS configs)', 'Add explicit MIME type mappings for .json and .png in IIS site settings'],
        ],
        [2400, 2400, 3600],
      ),

      h1('Rollback'),
      p('To take the app down: remove the IIS site binding (or "nginx -disite scanner && systemctl reload nginx" equivalent) and optionally remove the DNS record. No data is lost — the files can simply be redeployed later.'),

      h1('Notes for the next phase'),
      p('This deployment serves static files only. The YouTrack connection in this version is still simulated. Once real credentials are ready, a small server-side "token proxy" script will need to run alongside these files — confirm with whoever sets this up that the chosen server can run a small script (not just serve files) before that phase begins.'),

      h1('History'),
      table(['Date', 'Done by', 'Notes'], [['', '', '']], [2000, 2400, 4000]),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(__dirname + '/Label-Scanner-Internal-Deploy-Runbook.docx', buf);
  console.log('written');
});
