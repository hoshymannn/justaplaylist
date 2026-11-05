import { CONFIG } from './config.js';
import { readExport, parseChat, collectPosts, findBookmark, selectNew } from './core.js';
import {
  api, apiAll, login, logout, handleRedirect, isLoggedIn, isConfigured,
  redirectUri, LoginExpiredError, ApiError,
} from './spotify.js';

const MAX = CONFIG.maxSongs || 20;
const SHARE_CACHE = 'jap-share-v1';
const SHARE_KEY = new URL('pending-share', location.href).href;
const app = document.getElementById('app');

const state = {
  view: 'loading',          // loading | setup | login | main
  notice: null,             // { text, tone: 'error' | 'info' }
  me: null,
  playlists: [],
  playlistId: null,
  creating: false,
  chat: null,               // { fileName, messageCount, posts, others, fromShare }
  analysis: null,
  analyzing: false,
  forceFresh: false,
  updating: false,
  result: null,
  installPrompt: null,
};

/* ------------------------------------------------------------------ */
/* Small DOM helper                                                    */
/* ------------------------------------------------------------------ */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const artistsOf = t => (t?.artists || []).map(a => a.name).join(', ');

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.installPrompt = e;
    render();
  });

  if (!isConfigured()) { state.view = 'setup'; return render(); }

  try {
    const err = await handleRedirect();
    if (err) state.notice = { text: err, tone: 'error' };
  } catch {
    state.notice = { text: 'The login could not be completed. Check your connection and try again.', tone: 'error' };
  }

  await loadPendingShare();
  await start();

  // A login finished in another tab or window (e.g. from the installed app).
  const recheck = () => { if (state.view === 'login' && isLoggedIn()) start(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
  window.addEventListener('storage', recheck);
}

async function start() {
  if (!isLoggedIn()) { state.view = 'login'; return render(); }
  state.view = 'loading';
  render();
  try {
    state.me = await api('GET', '/me');
    await loadPlaylists();
    state.view = 'main';
  } catch (e) {
    handleError(e);
  }
  render();
  maybeAnalyze();
}

async function loadPlaylists() {
  const all = await apiAll('/me/playlists?limit=50', 500);
  state.playlists = all.filter(p => p && (p.owner?.id === state.me.id || p.collaborative));
  const remembered = readPref('playlist');
  if (!state.playlistId && state.playlists.some(p => p.id === remembered)) state.playlistId = remembered;
}

function readPref(name) {
  try { return localStorage.getItem(`jap.${name}.${state.me?.id}`); } catch { return null; }
}
function writePref(name, value) {
  try { localStorage.setItem(`jap.${name}.${state.me?.id}`, value); } catch { /* ignore */ }
}

function handleError(e) {
  if (e instanceof LoginExpiredError) {
    state.view = 'login';
    state.notice = { text: e.message, tone: 'error' };
  } else {
    state.notice = {
      text: e instanceof ApiError ? e.message : 'Something went wrong: ' + (e?.message || e),
      tone: 'error',
    };
  }
}

/* ------------------------------------------------------------------ */
/* Chat export                                                         */
/* ------------------------------------------------------------------ */

async function loadPendingShare() {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(SHARE_KEY);
    if (!res) return;
    const name = decodeURIComponent(res.headers.get('X-File-Name') || 'Shared chat');
    await loadChat(await res.arrayBuffer(), name, true);
  } catch { /* no cache support or nothing shared */ }
  if (new URL(location.href).searchParams.has('shared')) {
    history.replaceState(null, '', location.pathname);
  }
}

async function clearPendingShare() {
  try { await (await caches.open(SHARE_CACHE)).delete(SHARE_KEY); } catch { /* ignore */ }
}

async function loadChat(buffer, fileName, fromShare = false) {
  try {
    const text = await readExport(buffer);
    const messages = parseChat(text);
    const { posts, others } = collectPosts(messages);
    state.chat = { fileName, messageCount: messages.length, posts, others, fromShare };
    state.notice = null;
  } catch (e) {
    state.chat = null;
    state.notice = { text: `“${fileName}” couldn’t be read. ${e.message || ''}`.trim(), tone: 'error' };
  }
  state.result = null;
  state.forceFresh = false;
  state.analysis = null;
}

async function onFileChosen(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  await clearPendingShare();
  await loadChat(await file.arrayBuffer(), file.name);
  render();
  maybeAnalyze();
}

/* ------------------------------------------------------------------ */
/* Playlist choice                                                     */
/* ------------------------------------------------------------------ */

function onPlaylistChange(e) {
  const v = e.target.value;
  if (v === '__new') { state.creating = true; state.playlistId = null; }
  else { state.creating = false; state.playlistId = v || null; if (v) writePref('playlist', v); }
  state.analysis = null;
  state.result = null;
  state.forceFresh = false;
  render();
  maybeAnalyze();
}

async function onCreatePlaylist(e) {
  e.preventDefault();
  const name = e.target.elements.name.value.trim() || CONFIG.defaultPlaylistName;
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const pl = await api('POST', '/me/playlists', {
      name, public: false, description: 'Songs shared in our WhatsApp group.',
    });
    state.playlists.unshift(pl);
    state.playlistId = pl.id;
    state.creating = false;
    writePref('playlist', pl.id);
    state.notice = null;
  } catch (err) {
    handleError(err);
  }
  render();
  maybeAnalyze();
}

/* ------------------------------------------------------------------ */
/* Analysis and update                                                 */
/* ------------------------------------------------------------------ */

async function maybeAnalyze() {
  if (state.view !== 'main' || !state.playlistId || !state.chat || state.analyzing) return;
  state.analyzing = true;
  state.analysis = null;
  render();
  try {
    state.analysis = await analyze();
  } catch (e) {
    handleError(e);
  }
  state.analyzing = false;
  render();
}

async function analyze() {
  const id = state.playlistId;
  const { posts } = state.chat;

  // Current playlist contents: only the last ones matter.
  const head = await api('GET', `/playlists/${id}/items?limit=1`);
  const total = head?.total ?? 0;
  const offset = Math.max(0, total - 50);
  const page = total ? await api('GET', `/playlists/${id}/items?limit=50&offset=${offset}`) : { items: [] };
  const current = (page.items || [])
    .map(it => it.item || it.track)
    .filter(t => t && t.type === 'track' && !t.is_local && t.id);
  const currentIds = current.map(t => t.id);

  const bookmark = state.forceFresh ? { status: 'fresh' } : findBookmark(posts, currentIds, MAX);
  if (bookmark.status === 'not-found') {
    return { bookmark, total, currentCount: total };
  }
  const start = bookmark.status === 'found' ? bookmark.end + 1 : 0;
  const selection = selectNew(posts, start, MAX);

  // Look up titles; this also reveals links to songs that no longer exist.
  const details = new Map();
  await runLimited(selection.selected, 4, async p => {
    try {
      details.set(p.id, await api('GET', `/tracks/${p.id}`));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) details.set(p.id, null);
      else throw e;
    }
  });

  let lastPost = null, lastTrack = null;
  if (bookmark.status === 'found') {
    lastPost = posts[bookmark.end];
    lastTrack = current.find(t => t.id === lastPost.id) || current.at(-1);
  }
  return { bookmark, selection, details, currentCount: total, lastPost, lastTrack };
}

async function runLimited(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function onUpdate() {
  const a = state.analysis;
  const playlist = currentPlaylist();
  const uris = a.selection.selected
    .filter(p => a.details.get(p.id) !== null)
    .map(p => 'spotify:track:' + p.id);
  state.updating = true;
  render();
  try {
    await api('PUT', `/playlists/${playlist.id}/items`, { uris });
    state.result = { count: uris.length, playlist };
    state.analysis = null;
    state.forceFresh = false;
    state.notice = null;
    await clearPendingShare();
  } catch (e) {
    handleError(e);
  }
  state.updating = false;
  render();
}

function currentPlaylist() {
  return state.playlists.find(p => p.id === state.playlistId) || null;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const views = { loading: viewLoading, setup: viewSetup, login: viewLogin, main: viewMain };
  app.replaceChildren(...[views[state.view]()].flat().filter(Boolean));
}

function wordmark() {
  return h('h1', { class: 'wordmark' }, 'JustAPlaylist');
}

function notice() {
  if (!state.notice) return null;
  return h('p', { class: `notice notice-${state.notice.tone}`, role: state.notice.tone === 'error' ? 'alert' : 'status' },
    state.notice.text);
}

function viewLoading() {
  return [h('header', { class: 'masthead' }, wordmark()), h('p', { class: 'quiet', role: 'status' }, 'Loading…')];
}

function viewSetup() {
  return [
    h('header', { class: 'masthead' }, wordmark()),
    h('section', { class: 'block' },
      h('h2', {}, 'Almost ready'),
      h('p', {}, 'Add your Spotify Client ID to ', h('code', {}, 'config.js'), '. The README explains where to find it.'),
      h('p', {}, 'Register this address as the Redirect URI of your Spotify app:'),
      h('p', {}, h('code', { class: 'copyable' }, redirectUri)),
    ),
  ];
}

function viewLogin() {
  return [
    h('header', { class: 'masthead' }, wordmark(),
      h('p', { class: 'lede' }, 'Turns the songs posted in your WhatsApp group into a Spotify playlist that picks up where the last one ended.')),
    notice(),
    state.chat?.fromShare
      ? h('p', { class: 'notice notice-info' }, `“${state.chat.fileName}” is loaded. Log in to continue.`)
      : null,
    h('button', { class: 'primary', onclick: () => login() }, 'Log in with Spotify'),
    footer(),
  ];
}

function viewMain() {
  return [
    h('header', { class: 'masthead' }, wordmark(),
      h('p', { class: 'account' },
        `Logged in as ${state.me?.display_name || state.me?.id}. `,
        h('button', { class: 'link', onclick: () => { logout(); state.me = null; state.view = 'login'; render(); } }, 'Log out'))),
    notice(),
    sectionPlaylist(),
    sectionChat(),
    sectionPreview(),
    footer(),
  ];
}

function sectionPlaylist() {
  const select = h('select', { id: 'playlist', onchange: onPlaylistChange },
    h('option', { value: '', selected: !state.playlistId && !state.creating }, 'Choose a playlist'),
    state.playlists.map(p => h('option', { value: p.id, selected: p.id === state.playlistId }, p.name)),
    h('option', { value: '__new', selected: state.creating }, 'Create a new playlist…'),
  );
  return h('section', { class: 'block' },
    h('h2', {}, h('label', { for: 'playlist' }, 'Playlist')),
    select,
    state.creating
      ? h('form', { class: 'create', onsubmit: onCreatePlaylist },
          h('label', { for: 'pl-name', class: 'sr-only' }, 'Name of the new playlist'),
          h('input', { id: 'pl-name', name: 'name', value: CONFIG.defaultPlaylistName, autocomplete: 'off' }),
          h('button', { type: 'submit', class: 'secondary' }, 'Create playlist'),
          h('p', { class: 'hint' }, 'New playlists are private. You can make it public in Spotify later.'))
      : null,
  );
}

function sectionChat() {
  const c = state.chat;
  return h('section', { class: 'block' },
    h('h2', {}, 'Chat export'),
    c ? h('p', { class: 'loaded' },
          h('span', { class: 'file' }, c.fileName),
          h('span', { class: 'quiet' }, ` ${plural(c.messageCount, 'message', 'messages')}, ${plural(c.posts.length, 'song link', 'song links')}`))
      : h('p', { class: 'hint' }, 'In WhatsApp, open the group, tap ⋮, then More, Export chat and Without media.'),
    h('label', { class: c ? 'button secondary' : 'button primary-outline' },
      c ? 'Choose another export' : 'Choose chat export',
      h('input', { type: 'file', accept: '.txt,.zip,text/plain,application/zip', class: 'sr-only', onchange: onFileChosen })),
    state.installPrompt && !c
      ? h('p', { class: 'hint' },
          'Install the app to share exports straight from WhatsApp. ',
          h('button', { class: 'link', onclick: async () => { state.installPrompt.prompt(); state.installPrompt = null; render(); } }, 'Install app'))
      : null,
  );
}

function sectionPreview() {
  if (state.result) return sectionResult();
  if (!state.playlistId || !state.chat) return null;
  if (state.analyzing) return h('section', { class: 'block' }, h('p', { class: 'quiet', role: 'status' }, 'Comparing the chat with the playlist…'));
  const a = state.analysis;
  if (!a) return null;
  const playlist = currentPlaylist();

  if (a.bookmark.status === 'not-found') {
    return h('section', { class: 'block' },
      h('h2', {}, 'Where did the last update end?'),
      h('p', {}, `The songs in “${playlist.name}” don’t appear as a stretch in this chat export, so it’s unclear where to continue. This happens when the playlist was edited by hand or holds songs from somewhere else.`),
      h('button', { class: 'secondary', onclick: () => { state.forceFresh = true; maybeAnalyze(); } },
        `Start with the newest ${MAX} songs`),
    );
  }

  const { selection: s, details } = a;
  const usable = s.selected.filter(p => details.get(p.id) !== null);

  const intro = a.bookmark.status === 'found'
    ? (s.selected.length
        ? `${plural(s.newCount - s.duplicates, 'new song', 'new songs')} since the last update.`
        : 'No new songs since the last update. The playlist stays as it is.')
    : a.bookmark.status === 'empty'
      ? `This playlist is empty, so it starts with the newest ${MAX} songs in the chat.`
      : `Starting fresh with the newest ${MAX} songs in the chat.`;

  const rows = [];
  if (a.bookmark.status === 'found') {
    rows.push(h('li', { class: 'mark' },
      h('span', { class: 'ribbon' }, 'Last update ended here'),
      h('span', { class: 'mark-song' },
        a.lastTrack ? `${a.lastTrack.name} by ${artistsOf(a.lastTrack)}` : 'Last song of the playlist'),
      h('span', { class: 'meta' }, metaLine(a.lastPost))));
  }
  if (s.skippedOlder.length) {
    const label = a.bookmark.status === 'found'
      ? `${plural(s.skippedOlder.length, 'earlier new song is', 'earlier new songs are')} left out, the playlist holds ${MAX}.`
      : `${plural(s.skippedOlder.length, 'older song', 'older songs')} in the chat ${s.skippedOlder.length === 1 ? 'is' : 'are'} left out.`;
    rows.push(h('li', { class: 'gap' },
      a.bookmark.status === 'found'
        ? h('details', {}, h('summary', {}, label),
            h('ul', { class: 'plain' }, s.skippedOlder.map(p =>
              h('li', {}, h('a', { href: `https://open.spotify.com/track/${p.id}`, target: '_blank', rel: 'noopener' }, 'Song link'), ' ', h('span', { class: 'meta' }, metaLine(p))))))
        : h('span', {}, label)));
  }
  for (const p of s.selected) {
    const t = details.get(p.id);
    rows.push(h('li', { class: t === null ? 'song missing' : 'song' },
      t === null
        ? h('span', { class: 'title' }, 'Not found on Spotify, left out')
        : h('a', { class: 'title', href: `https://open.spotify.com/track/${p.id}`, target: '_blank', rel: 'noopener' }, t.name),
      t ? h('span', { class: 'artist' }, artistsOf(t)) : null,
      h('span', { class: 'meta' }, metaLine(p))));
  }

  return h('section', { class: 'block preview' },
    h('h2', {}, 'Preview'),
    h('p', {}, intro),
    rows.length ? h('ol', { class: 'timeline' }, rows) : null,
    s.duplicates ? h('p', { class: 'hint' }, `${plural(s.duplicates, 'repeat posting', 'repeat postings')} of the same song counted once.`) : null,
    otherLinks(),
    usable.length
      ? h('div', { class: 'commit' },
          h('p', {}, a.currentCount
            ? `“${playlist.name}” will be cleared (${plural(a.currentCount, 'song', 'songs')} now) and get these ${plural(usable.length, 'song', 'songs')}.`
            : `“${playlist.name}” will get these ${plural(usable.length, 'song', 'songs')}.`),
          h('button', { class: 'primary', onclick: onUpdate, disabled: state.updating },
            state.updating ? 'Updating playlist…' : 'Update playlist'))
      : null,
  );
}

function otherLinks() {
  const others = state.chat.others;
  if (!others.length) return null;
  const names = { album: 'Album', playlist: 'Playlist', artist: 'Artist', episode: 'Podcast episode',
    show: 'Podcast', audiobook: 'Audiobook', shortlink: 'Short link' };
  const hasShort = others.some(o => o.kind === 'shortlink');
  return h('details', { class: 'others' },
    h('summary', {}, `${plural(others.length, 'Spotify link in the chat isn’t a song', 'Spotify links in the chat aren’t songs')} and ${others.length === 1 ? 'isn’t' : 'aren’t'} added`),
    hasShort ? h('p', { class: 'hint' }, 'Short links (spotify.link) can’t be opened by this page. If one of them is a song, it needs to be posted again as a full open.spotify.com link.') : null,
    h('ul', { class: 'plain' }, others.map(o =>
      h('li', {}, h('a', { href: o.url, target: '_blank', rel: 'noopener' }, names[o.kind] || o.kind), ' ', h('span', { class: 'meta' }, metaLine(o))))));
}

function metaLine(p) {
  if (!p) return '';
  return [p.sender, p.stamp].filter(Boolean).join(', ');
}

function sectionResult() {
  const { count, playlist } = state.result;
  return h('section', { class: 'block result', role: 'status' },
    h('h2', {}, 'Playlist updated'),
    h('p', {}, `“${playlist.name}” now has ${plural(count, 'song', 'songs')}.`),
    playlist.external_urls?.spotify
      ? h('a', { class: 'button primary', href: playlist.external_urls.spotify, target: '_blank', rel: 'noopener' }, 'Open in Spotify')
      : null,
  );
}

function footer() {
  return h('footer', { class: 'colophon' },
    'Your chat export stays on this device. Only the song links are sent to Spotify.');
}

init();
