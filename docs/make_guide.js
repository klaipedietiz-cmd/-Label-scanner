const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  LevelFormat, convertInchesToTwip,
} = require('docx');

const ORANGE = 'D97757';
const DARK = '1C1C1E';
const MUTED = '4B5563';

function h(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, color: DARK, size: 30 })],
  });
}
function body(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 140 },
    children: [new TextRun({ text, color: opts.color || DARK, italics: !!opts.italic, size: 22 })],
  });
}
function step(n, title, detail) {
  return [
    new Paragraph({
      numbering: { reference: 'steps', level: 0 },
      spacing: { after: 40 },
      children: [new TextRun({ text: title, bold: true, color: DARK, size: 23 })],
    }),
    new Paragraph({
      indent: { left: convertInchesToTwip(0.3) },
      spacing: { after: 160 },
      children: [new TextRun({ text: detail, color: MUTED, size: 21 })],
    }),
  ];
}

const doc = new Document({
  numbering: {
    config: [{
      reference: 'steps',
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.25) } } } }],
    }],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
    children: [
      new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: 'Label Scanner — getting it onto your phone', bold: true, color: ORANGE, size: 34 })],
      }),
      body('A short, one-time setup so the app has a real web address your phone can open. After this, testing is just opening a link in your browser — no files, no unzipping.', { italic: true }),

      h('Why this step is needed'),
      body('Opening the app by unzipping a file and tapping it directly does not work reliably — on iPhone it does not work at all, and on Android it usually loads with no styling and no working buttons. This is a phone/browser limitation, not a problem with the app itself. Once the files live at a real web address, everything — including the camera — works normally.'),

      h('Part 1 — on your computer'),
      ...step(1, 'Create a free GitHub account', 'Go to github.com and sign up with your email, if you don’t already have an account. Verify your email address when asked.'),
      ...step(2, 'Create a new repository', 'Click the "+" in the top-right corner, then "New repository." Give it a name, for example "label-scanner". Leave it set to Public. Click "Create repository."'),
      ...step(3, 'Upload the app files', 'On the new repository’s page, click "uploading an existing file." Unzip the label-scanner-app.zip file you already have, then drag everything from inside that folder — index.html, app.js, styles.css, jsQR.js, manifest.json, sw.js, and the icons folder — into the upload box. Click "Commit changes."'),
      ...step(4, 'Turn on Pages (this makes it a live website)', 'Click the "Settings" tab near the top of the repository, then "Pages" in the left-hand list. Under "Build and deployment," set Source to "Deploy from a branch," Branch to "main," folder "/ (root)." Click "Save."'),
      ...step(5, 'Get the link', 'Wait about a minute, then refresh that Settings > Pages screen. GitHub will show a live web address, something like https://your-username.github.io/label-scanner/. That address is what you’ll open on your phone.'),

      h('Part 2 — on your phone'),
      ...step(6, 'Open the link in your phone’s browser', 'Type or paste that address directly into Safari (iPhone) or Chrome (Android) — the same way you’d visit any normal website. Do not open it through a file or a downloaded zip.'),
      ...step(7, 'Allow the camera when asked, and try it', 'The browser should now ask for camera permission properly. Allow it, then try pointing at a label. If you want it as a home-screen icon: on iPhone use Share → "Add to Home Screen"; on Android use the menu (⋮) → "Add to Home screen" or "Install app."'),

      h('If something still doesn’t work'),
      body('Send a screenshot of exactly what you see and which step you were on — that’s enough to figure out the fix without guessing.'),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(__dirname + '/Label-Scanner-Setup-Guide.docx', buf);
  console.log('written');
});
