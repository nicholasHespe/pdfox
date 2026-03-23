// Reamlet native messaging host
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Compiled into a standalone exe (no Node.js runtime required):
//   pnpm run build-native-host
//
// The resulting native-host/dist/reamlet-native-host.exe is bundled
// alongside Reamlet.exe by electron-builder and registered by the
// NSIS installer or by running register-host.bat (portable build).
//
// Chrome native messaging protocol:
//   stdin/stdout — 4-byte little-endian uint32 length prefix + UTF-8 JSON.

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

// ── Native messaging framing ──────────────────────────────────

const chunks = [];
let expectedLength = null;

process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  processInput();
});

process.stdin.on('end', () => process.exit(0));

function processInput() {
  const buf = Buffer.concat(chunks);

  if (expectedLength === null) {
    if (buf.length < 4) return;
    expectedLength = buf.readUInt32LE(0);
    chunks.length = 0;
    chunks.push(buf.slice(4));
    processInput();
    return;
  }

  if (buf.length < expectedLength) return;

  const msgJson = buf.slice(0, expectedLength).toString('utf8');
  chunks.length = 0;
  chunks.push(buf.slice(expectedLength));
  expectedLength = null;

  try {
    handleMessage(JSON.parse(msgJson));
  } catch {
    reply({ ok: false, error: 'parse error' });
  }

  processInput();
}

function reply(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len  = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(len);
  process.stdout.write(json);
}

// ── Locate Reamlet.exe ────────────────────────────────────────
//
// The host exe is placed in the same directory as Reamlet.exe by
// electron-builder (extraFiles), so process.execPath's directory is
// always the right place to look first.

function findReamlet() {
  const candidates = [
    // Installed / portable: same directory as this exe
    path.join(path.dirname(process.execPath), 'Reamlet.exe'),
    // NSIS default install location (fallback)
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Reamlet', 'Reamlet.exe'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { found: candidate, checked: candidates };
    } catch { /* ignore */ }
  }
  return { found: null, checked: candidates };
}

// ── Message handler ───────────────────────────────────────────

function handleMessage(msg) {
  const { url, background } = msg;
  if (!url || typeof url !== 'string') {
    reply({ ok: false, error: 'missing url' });
    return;
  }

  const { found: reamletPath, checked } = findReamlet();
  if (!reamletPath) {
    reply({ ok: false, error: 'Reamlet.exe not found', checked });
    return;
  }

  const args = background ? [url, '--background'] : [url];
  const child = spawn(reamletPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  reply({ ok: true });
}
