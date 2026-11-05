# JustAPlaylist

Turns the Spotify songs posted in a WhatsApp group into a playlist. Each update
clears the playlist and fills it with the songs posted since the last update,
newest last, up to 20.

The page runs entirely in the browser. The chat export never leaves your device;
only the song links go to Spotify.

## Setup (about 10 minutes)

In the steps below, replace `USERNAME` with your GitHub username.

### 1. Put the files on GitHub Pages

1. On GitHub, create a new **public** repository named `justaplaylist`.
2. Click **Add file → Upload files** and drag in all files and folders from this
   package (`index.html`, `app.js`, `core.js`, `spotify.js`, `config.js`,
   `style.css`, `sw.js`, `manifest.webmanifest`, and the `fonts` and `icons`
   folders). Commit.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose
   **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute or two, the page is live at
   `https://USERNAME.github.io/justaplaylist/`. It will ask for a Client ID;
   that's the next step.

### 2. Create the Spotify app

1. Open <https://developer.spotify.com/dashboard> and log in with the Spotify
   account that has Premium.
2. Click **Create app** and fill in:
   - **App name:** JustAPlaylist (anything works)
   - **App description:** anything
   - **Redirect URI:** `https://USERNAME.github.io/justaplaylist/`
     — exactly like this, including the trailing slash. Click **Add**.
   - **Which API/SDKs:** tick **Web API**.
3. Accept the terms and save.
4. Open the app's **Settings** and copy the **Client ID**. You won't need the
   client secret.

### 3. Add the Client ID

1. In your GitHub repository, open `config.js` and click the pencil icon.
2. Replace `PASTE_YOUR_CLIENT_ID_HERE` with your Client ID (keep the quotes).
   Commit.
3. Wait a minute, then open the page and log in with Spotify.

The Client ID is meant to be public in apps like this one, so it's fine in a
public repository.

### 4. On your Android phone

1. Open `https://USERNAME.github.io/justaplaylist/` in Chrome and log in.
2. Open Chrome's menu and choose **Add to Home screen** (on some phones it says
   **Install app**), then **Install**.
3. From now on: in WhatsApp, open the group, tap **⋮ → More → Export chat →
   Without media**, and pick **JustAPlaylist** in the share sheet.

If JustAPlaylist doesn't show up in the share sheet right away, open the
installed app once and try again.

## Using it

1. Choose the playlist (or create a new one; new playlists are private).
2. Load the chat export, either through the share sheet or with
   **Choose chat export**.
3. Check the preview and tap **Update playlist**.

### How it knows where the last update ended

Nothing is stored anywhere. After each update, the playlist holds an unbroken
stretch of songs from the chat. On the next run, the page finds that stretch in
the new export, and everything posted after it is new. Reposts of older songs
count as new posts.

Small differences are tolerated: a song that couldn't be added, or a song
Spotify swapped for another version of itself. If the playlist was edited by
hand and the stretch can't be found, the page says so and offers to start
fresh with the newest 20 songs.

- **More than 20 new songs:** the newest 20 go in; the earlier ones are left out
  for good.
- **No new songs:** the playlist stays as it is.
- **Empty playlist:** starts with the newest 20 songs in the chat.
- **The same song posted twice in one update:** it appears once, at its latest
  posting.

## Letting others in the group use it

Anyone can listen to or follow the playlist. To let someone else *run the tool*
with their own Spotify account, add them in the Spotify dashboard under your
app's **User Management** (their name and the email of their Spotify account).
Spotify allows up to five people for apps like this. They then use the same
address, `https://USERNAME.github.io/justaplaylist/`.

## Good to know

- **Short links** (`spotify.link/…`) can't be opened by a web page, so they're
  listed as not added. Full `open.spotify.com` links always work.
- **Albums, playlists, podcasts and artists** posted in the chat are listed but
  not added.
- **Login:** Spotify asks you to log in again about every six months. Each
  browser keeps its own login.
- **Share sheet:** works in Chrome, Edge and Samsung Internet on Android. In
  Firefox, on iPhones and on computers, use **Choose chat export**.
- **Premium:** the app stops working if the Premium subscription of the app
  owner lapses, and works again once it's renewed.
- **Export limit:** WhatsApp exports at most the last 40,000 messages without
  media.
- **Other GitHub Pages projects:** all your project pages share the address
  `USERNAME.github.io` and therefore browser storage. If you host other pages
  there, they could in principle read JustAPlaylist's stored Spotify login.

## Settings

`config.js` also holds the maximum number of songs (`maxSongs`, default 20) and
the suggested name for new playlists.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css` | The page |
| `app.js` | Screens and flow |
| `core.js` | Reading the export, finding links, finding where the last update ended |
| `spotify.js` | Spotify login and API calls |
| `config.js` | Your Client ID and settings |
| `sw.js` | Receives exports shared from WhatsApp |
| `manifest.webmanifest`, `icons/` | Install as an app, share-sheet entry |
| `fonts/` | Funnel Sans and Funnel Display (SIL Open Font License), served from your site |

## Updating

Replace the changed files in the repository. The page and the installed app
load the new version the next time they're opened; nothing is cached.
