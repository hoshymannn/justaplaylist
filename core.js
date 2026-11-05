// JustAPlaylist – core logic without any UI or network code.
// Everything here works on plain data, so it can be tested on its own.

/* ------------------------------------------------------------------ */
/* Reading the export file (.txt or .zip)                              */
/* ------------------------------------------------------------------ */

export async function readExport(buffer) {
  const bytes = new Uint8Array(buffer);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const textBytes = isZip ? await extractTextFromZip(bytes) : bytes;
  return new TextDecoder('utf-8').decode(textBytes);
}

async function extractTextFromZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the "end of central directory" record (signature 0x06054b50).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This ZIP file looks damaged.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const txt = entries.filter(e => /\.txt$/i.test(e.name));
  const entry = txt.find(e => /chat/i.test(e.name)) || txt[0];
  if (!entry) throw new Error('This ZIP file contains no chat text file.');

  const lp = entry.localOffset;
  const dataStart = lp + 30 + view.getUint16(lp + 26, true) + view.getUint16(lp + 28, true);
  const data = bytes.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error('This ZIP file uses an unsupported compression method.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Parsing the chat                                                    */
/* ------------------------------------------------------------------ */

// Date and time as WhatsApp writes them in various languages, e.g.
// "05.11.26, 14:32", "11/5/26, 2:32 PM", "2026-11-05 14:32:10".
const STAMP = String.raw`\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:[\s\u202f\u00a0]*(?:[AaPp]\.?\s?[Mm]\.?))?`;
const IOS_LINE = new RegExp(String.raw`^\[(${STAMP})\]\s*(.*)$`);
const ANDROID_LINE = new RegExp(String.raw`^(${STAMP})\s+[-–]\s+(.*)$`);
const SENDER = /^([^:]{1,80}?):\s?([\s\S]*)$/;
const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function parseChat(text) {
  const messages = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(INVISIBLE, '');
    const m = line.match(IOS_LINE) || line.match(ANDROID_LINE);
    if (m) {
      const stamp = m[1].replace(/[\u202f\u00a0]/g, ' ').trim();
      const rest = m[2];
      const s = rest.match(SENDER);
      current = s
        ? { stamp, sender: cleanSender(s[1]), text: s[2] }
        : { stamp, sender: null, text: rest }; // system message
      messages.push(current);
    } else if (current) {
      current.text += '\n' + line; // continuation of a multi-line message
    } else if (line.trim()) {
      current = { stamp: null, sender: null, text: line };
      messages.push(current);
    }
  }
  return messages;
}

function cleanSender(name) {
  return name.replace(/^~[\s\u202f\u00a0]*/, '').trim();
}

/* ------------------------------------------------------------------ */
/* Finding Spotify links                                               */
/* ------------------------------------------------------------------ */

const LINK = new RegExp(
  [
    String.raw`(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:embed\/)?(track|album|playlist|artist|episode|show|audiobook)\/([A-Za-z0-9]{22})`,
    String.raw`spotify:(track|album|playlist|artist|episode|show|audiobook):([A-Za-z0-9]{22})`,
    String.raw`(?:https?:\/\/)?(?:spotify\.link|spotify\.app\.link)\/[A-Za-z0-9_-]+`,
  ].join('|'),
  'gi',
);

export function extractLinks(text) {
  const out = [];
  for (const m of text.matchAll(LINK)) {
    const kind = (m[1] || m[3] || 'shortlink').toLowerCase();
    const id = m[2] || m[4] || null;
    let url = m[0];
    if (!/^https?:|^spotify:/i.test(url)) url = 'https://' + url;
    if (kind !== 'shortlink') url = `https://open.spotify.com/${kind}/${id}`;
    out.push({ kind, id, url });
  }
  return out;
}

// Turns the chat into the list of song posts (in chat order) plus a list
// of Spotify links that aren't songs.
export function collectPosts(messages) {
  const posts = [];
  const others = [];
  for (const msg of messages) {
    for (const link of extractLinks(msg.text)) {
      const base = { stamp: msg.stamp, sender: msg.sender };
      if (link.kind === 'track') posts.push({ ...base, id: link.id, seq: posts.length });
      else others.push({ ...base, kind: link.kind, url: link.url });
    }
  }
  return { posts, others };
}

/* ------------------------------------------------------------------ */
/* Finding where the last update ended                                 */
/* ------------------------------------------------------------------ */

// The playlist holds an unbroken stretch of song posts from the chat.
// We look for that stretch and return the index of its last post.
// Small differences are tolerated: songs Spotify couldn't add, songs
// Spotify replaced with another version, duplicates that were left out.
export function findBookmark(posts, playlistIds, maxSongs = 20) {
  const P = playlistIds.slice(-maxSongs);
  const n = P.length;
  if (n === 0) return { status: 'empty' };

  const needed = n === 1 ? 1 : Math.max(2, Math.ceil(n * 0.6));
  const slack = 10;
  let best = null;

  // Try the last few playlist songs as anchor, in case the very last one
  // was swapped for another version by Spotify.
  for (let k = n - 1; k >= Math.max(0, n - 3); k--) {
    for (let e = posts.length - 1; e >= 0; e--) {
      if (posts[e].id !== P[k]) continue;
      const from = Math.max(0, e - (k + 1) - slack);
      const windowIds = posts.slice(from, e + 1).map(p => p.id);
      const matched = lcsLength(windowIds, P.slice(0, k + 1));
      const end = Math.min(posts.length - 1, e + (n - 1 - k));
      if (!best || matched > best.matched || (matched === best.matched && end > best.end)) {
        best = { matched, end };
      }
    }
  }

  if (!best || best.matched < needed) return { status: 'not-found' };
  return { status: 'found', end: best.end, matched: best.matched, total: n };
}

function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[b.length];
}

/* ------------------------------------------------------------------ */
/* Choosing the songs for this update                                  */
/* ------------------------------------------------------------------ */

// Takes all posts from `start` on, keeps the newest `max` distinct songs
// (a song posted twice counts once, at its latest posting) and returns
// them in chat order, newest last.
export function selectNew(posts, start, max = 20) {
  const candidates = posts.slice(start);
  const seen = new Set();
  const picked = [];
  const older = [];
  let duplicates = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const p = candidates[i];
    if (seen.has(p.id)) { duplicates++; continue; }
    seen.add(p.id);
    if (picked.length < max) picked.push(p);
    else older.push(p);
  }
  return { selected: picked.reverse(), skippedOlder: older.reverse(), duplicates, newCount: candidates.length };
}
