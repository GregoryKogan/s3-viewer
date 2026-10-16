// Test fixtures. Generated on demand into e2e/fixtures/generated/ (gitignored:
// the big ones are several megabytes and there is no reason to store them).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.join(import.meta.dirname, "fixtures", "generated");

/** A real PNG: 96x64 RGB gradient with a diagonal, so previews show something. */
export function makePng(width = 96, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[offset++] = Math.floor((x / width) * 255);
      raw[offset++] = Math.floor((y / height) * 255);
      raw[offset++] = x === y ? 255 : 64;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A WAV file with a short sine tone, playable in any webview. */
export function makeWav({ seconds = 1.2, rate = 22050, frequency = 440 } = {}) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * frequency * i) / rate) * 0.35 * 32767;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * A minimal valid MP4 container: `ftyp` + `mdat` with no media data.
 * WebKit will open it and report metadata rather than a decode error, which is
 * what the preview test needs to distinguish "wired up" from "broken".
 */
export function makeMp4() {
  const box = (type, payload) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + payload.length);
    return Buffer.concat([size, Buffer.from(type, "ascii"), payload]);
  };
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from("isom", "ascii"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isomiso2avc1mp41", "ascii"),
  ]));
  const mdat = box("mdat", Buffer.alloc(0));
  return Buffer.concat([ftyp, mdat]);
}

/** A tiny text payload served as video/mp4 (see the note in writeFixtures). */
export function makeShellScript() {
  return Buffer.from("#!/bin/sh\necho 'video preview fixture'\n", "utf8");
}

/** A minimal one-page PDF. */
export function makePdf(text = "S3 Viewer preview fixture") {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${text.length + 40} >>\nstream\nBT /F1 16 Tf 20 60 Td (${text}) Tj ET\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

export function makeBinary(size = 4096) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    // NUL bytes and non-UTF8 sequences: this must classify as binary.
    buffer[i] = i % 256 === 0 ? 0 : (i * 31) % 256;
  }
  return buffer;
}

const SMALL_TEXT_FILES = {
  "readme.md": `# Preview test document

This file exists so the Markdown renderer has something with **structure**.

## Features

- headings, **bold**, *italic*, \`inline code\`
- [a link](https://example.com/very/long/path)
- tables and quotes

| Column | Value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

> A block quote with \`code\`.

\`\`\`python
def hello(name):
    return f"hello {name}"
\`\`\`
`,
  "notes.txt": [
    "Plain text preview fixture.",
    "Line two with unicode: привет мир — 你好 — 🎉",
    "Line three.",
    "",
  ].join("\n"),
  "sample.json": JSON.stringify(
    {
      name: "preview-fixture",
      nested: { list: [1, 2, 3], flag: true, nothing: null },
      unicode: "привет",
    },
    null,
    2,
  ),
  "sample.py": [
    "import json",
    "",
    "",
    "class Greeter:",
    '    """Say hello."""',
    "",
    "    def __init__(self, name: str) -> None:",
    "        self.name = name",
    "",
    "    def greet(self) -> str:",
    "        # a comment",
    '        return f"hello {self.name}"',
    "",
    "",
    "if __name__ == '__main__':",
    "    print(json.dumps({'greeting': Greeter('world').greet()}))",
    "",
  ].join("\n"),
  "table.csv": ["name,size,note", "alpha,1,first", 'beta,2,"quoted, value"', "gamma,3,third"].join("\n"),
};
const SMALL_TEXT_FILE_NAMES = Object.keys(SMALL_TEXT_FILES);

/** Write every fixture. Returns the directory. */
export function writeFixtures({ bigBytes = 80 * 1024 * 1024 } = {}) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  fs.writeFileSync(path.join(OUT, "image.png"), makePng());
  fs.writeFileSync(path.join(OUT, "tone.wav"), makeWav());
  // WebKit cannot decode a synthetic MP4, so the video fixture is a shell
  // script with an .mp4 name: it proves classification, the element wiring and
  // ranged reads without depending on a decoder.
  fs.writeFileSync(path.join(OUT, "clip.mp4"), makeShellScript());
  fs.writeFileSync(path.join(OUT, "document.pdf"), makePdf());
  fs.writeFileSync(path.join(OUT, "blob.bin"), makeBinary());
  fs.writeFileSync(
    path.join(OUT, "vector.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2b6ce0"/><circle cx="30" cy="30" r="20" fill="#ffffff"/></svg>`,
  );
  for (const [name, content] of Object.entries(SMALL_TEXT_FILES)) {
    fs.writeFileSync(path.join(OUT, name), content);
  }

  // One file above the default 25 MB preview limit, written in chunks.
  const bigPath = path.join(OUT, "too-big.txt");
  const chunkSize = 1024 * 1024;
  const chunk = Buffer.alloc(chunkSize, "x");
  const fd = fs.openSync(bigPath, "w");
  for (let written = 0; written < bigBytes; written += chunkSize) {
    fs.writeSync(fd, chunk, 0, Math.min(chunkSize, bigBytes - written));
  }
  fs.writeSync(fd, Buffer.from("\npreview-limit-probe\n"));
  fs.closeSync(fd);

  return OUT;
}

export const SMALL_FILES = [
  "image.png",
  "tone.wav",
  "clip.mp4",
  "document.pdf",
  "vector.svg",
  "blob.bin",
  ...SMALL_TEXT_FILE_NAMES,
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = writeFixtures();
  console.log(`fixtures written to ${dir}`);
  for (const name of fs.readdirSync(dir)) {
    console.log(`  ${name} ${fs.statSync(path.join(dir, name)).size} bytes`);
  }
}
