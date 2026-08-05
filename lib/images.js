'use strict';
/*
 * Image previews for the Changes and Conflicts views.
 *
 * A diff of a sprite is useless — nobody has ever resolved an art conflict by reading PNG
 * chunk bytes. What decides it is seeing the two pictures next to each other, and knowing
 * their dimensions, because "both sides changed this tile" and "one side is the 32×32 and
 * the other is the 64×64 re-export" are different problems with different answers.
 *
 * Two deliberate restrictions, both about the privileged local origin this app runs in:
 *
 *   1. Images come back as base64 data URIs inside JSON, NOT from a route that serves bytes.
 *      The page's CSP is `img-src data:` and stays that way. A same-origin endpoint handing
 *      back a Content-Type derived from a filename inside a repository is a bigger surface
 *      than the feature is worth.
 *   2. SVG is not previewable. It is markup, it can carry script, and there is no version of
 *      "render this untrusted SVG" that is worth the risk here. It falls back to the ordinary
 *      text diff, where it is readable anyway.
 */

const fs = require('fs');
const path = require('path');
const { gitBytes, bad } = require('./exec');

/*
 * Raster formats only, matched on extension AND confirmed by magic bytes before anything is
 * sent. The extension picks the candidate; the signature decides — a file named .png that is
 * not a PNG is not going to be labelled one.
 */
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/* Comfortably above any sprite; a photo or a layered export falls back to "too large". */
const MAX_PREVIEW = 4 * 1024 * 1024;

const mimeFor = (p) => TYPES[path.extname(String(p || '')).toLowerCase()] || null;
const isImage = (p) => mimeFor(p) !== null;

/* ── format sniffing ─────────────────────────────────────────────── */

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02)) return 'image/x-icon';
  return null;
}

/*
 * Width and height from the header alone — no decoding, no dependency.
 *
 * Worth the parsing because dimensions are frequently the whole answer. Two sprites that look
 * identical at preview size and differ 32×32 vs 64×64 are not the same asset, and the picture
 * on its own will not tell you which is which.
 */
function dimensions(buf, mime) {
  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: 8-byte signature, 4-byte length, 4-byte type.
      if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/bmp') {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (mime === 'image/x-icon') {
      // 0 in the size byte means 256 — the format has no room for the literal value.
      return { width: buf[6] || 256, height: buf[7] || 256 };
    }
    if (mime === 'image/webp') {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xFFFFFF) + 1, height: (buf.readUIntLE(27, 3) & 0xFFFFFF) + 1 };
      if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 };
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      // Walk the segment chain to the first start-of-frame, which carries the size.
      // The frame header is 9 bytes from `i`, so the last usable start is length - 9.
      let i = 2;
      while (i + 9 <= buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15, excluding the four that are not frame headers.
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (len <= 0) return null;
        i += 2 + len;
      }
      return null;
    }
  } catch { /* a truncated or malformed header is not an error worth raising */ }
  return null;
}

/* ── reading one version of a file ───────────────────────────────── */

/*
 * `side` names a version, not a git ref, because the caller is a UI panel and the mapping
 * differs by view: the Changes pane compares the working tree against HEAD, while a conflict
 * has three recorded stages and possibly no working file at all.
 */
const SIDES = {
  worktree: null,              // read from disk
  head: 'HEAD:',
  base: ':1:',
  ours: ':2:',
  theirs: ':3:',
};

async function read(dir, filePath, side) {
  if (!Object.prototype.hasOwnProperty.call(SIDES, side)) bad('Unknown image version');
  if (side === 'worktree') {
    const root = path.resolve(dir);
    const abs = path.resolve(root, filePath);
    if (abs !== root && !abs.startsWith(root + path.sep)) bad('That path is outside the repository');
    try { return fs.readFileSync(abs); } catch { return null; }
  }
  // `--` is not accepted after a rev:path spec, but the prefix already makes a leading dash
  // part of the path rather than a flag.
  return gitBytes(dir, ['show', SIDES[side] + filePath]).catch(() => null);
}

/*
 * One version, described. Returns `null` for a version that does not exist — a file added on
 * only one side genuinely has no "before", and the panel says so rather than showing an error.
 */
async function version(dir, filePath, side) {
  const declared = mimeFor(filePath);
  if (!declared) bad('That file is not a previewable image');
  const buf = await read(dir, filePath, side);
  if (!buf || !buf.length) return null;

  const actual = sniff(buf);
  const size = buf.length;
  const dims = actual ? dimensions(buf, actual) : null;
  const out = {
    side, bytes: size,
    mime: actual, declared,
    width: dims ? dims.width : null,
    height: dims ? dims.height : null,
    // Named so the UI can say "this is not actually a PNG" rather than showing a broken image
    // icon and leaving the person to guess whether the file or the app is wrong.
    mismatched: !!(actual && actual !== declared && !(declared === 'image/jpeg' && actual === 'image/jpeg')),
    tooBig: size > MAX_PREVIEW,
    data: null,
  };
  if (!actual) { out.unreadable = true; return out; }
  if (!out.tooBig) out.data = 'data:' + actual + ';base64,' + buf.toString('base64');
  return out;
}

/*
 * Every version a panel wants, in one request. Two round trips per conflicted sprite would be
 * three, and the panel cannot draw anything until it has them all anyway.
 */
async function compare(dir, filePath, sides) {
  const wanted = (Array.isArray(sides) && sides.length ? sides : ['head', 'worktree'])
    .map(String).filter(s => Object.prototype.hasOwnProperty.call(SIDES, s));
  if (!wanted.length) bad('No image versions were requested');
  const out = {};
  for (const side of wanted) out[side] = await version(dir, filePath, side);
  return out;
}

module.exports = { isImage, mimeFor, sniff, dimensions, version, compare, TYPES, MAX_PREVIEW };
