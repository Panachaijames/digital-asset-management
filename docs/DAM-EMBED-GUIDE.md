# Embedding Digital Assets

You can put Digital Assets into any dwp page with an `<iframe>`. There are two
things you can embed, and the right one depends on what the page is for.

Either way, it shows assets **only to signed-in dwp staff** — but they can sign
in from inside the embed itself, without leaving your page (section 5). Neither
is a public gallery, and neither can be made into one by changing the URL.

---

## 1. Which one to embed

**The full app** — the real thing, with the sidebar, the folder tree, upload,
tagging and Slides export. Use it when the embedded page is a workspace and the
people using it are staff who would otherwise open Digital Assets in its own
tab.

```html
<iframe
  src="https://dwp-dam-s2r2rmdlzq-eu.a.run.app/browse"
  width="100%"
  height="900"
  style="border: 0"
  title="Digital Assets"
></iframe>
```

Give it room. The app is a full workspace with its own scrolling panes, and
below roughly 900px tall it feels cramped.

**The gallery** — a read-only grid at `/embed`, with no sidebar, no top bar and
no editing controls, filtered to whatever you point it at. Use it when the page
is for showing assets rather than working on them: a project page, an intranet
post, a dashboard. It is what the rest of this guide describes.

```html
<iframe
  src="https://dwp-dam-s2r2rmdlzq-eu.a.run.app/embed?pathPrefix=dwp_Digital_Asset/dwp%20Projects/Thailand"
  width="100%"
  height="640"
  style="border: 0"
  title="Digital Assets"
  loading="lazy"
></iframe>
```

There is nothing to arrange first. Any dwp page can frame either one as things
stand — no allowlist to be added to, no request to file.

One thing to weigh before embedding the full app: it includes the controls that
delete assets and folders. Anyone who can edit the page holding the iframe can
position things over it, so put the full app only on pages you control. The
gallery has no such controls at all, which is a good reason to prefer it on a
page that other people can edit. The Digital Assets owner can also restrict
framing to named origins at any time by setting `DAM_EMBED_ORIGINS` — if that
happens, an iframe from an origin not on the list goes blank and the browser
console names `frame-ancestors`.

---

## 2. Pointing the gallery at something

Everything the gallery shows is decided by query parameters on its URL.

---

## 3. Parameters

### Choosing what appears

| Parameter | Example | What it does |
|---|---|---|
| `pathPrefix` | `dwp_Digital_Asset/dwp Projects/Thailand` | A folder and everything under it. The usual choice. |
| `path` | `dwp_Digital_Asset/dwp Projects/Thailand` | That one folder only, no subfolders. Wins over `pathPrefix` if you send both. |
| `tags` | `exterior,facade` | Assets carrying **all** of these tags. |
| `q` | `lobby` | Matches the asset name, case-insensitive, partial. |
| `macro` | `Lifestyle` | Macro Portfolio, exact. |
| `core` | `Hospitality` | Core Sector, exact. |
| `sub` | `Luxury Resort` | Sub-Sectors, comma-separated, all of them. |
| `studio` | `bangkok` | A dwp studio, matched on the location folder. |
| `permission` | `granted` | `granted`, `pending` or `restricted`. Use `granted` for anything a client might see. |
| `sort` | `oldest` | `newest` (default) or `oldest`. |
| `limit` | `24` | Assets per page, 1–200. Default 60. |

Folder paths start with the Shared Drive name and are case-sensitive. Percent-
encode them: a space is `%20`.

### Choosing how it looks

| Parameter | Values | Default | What it does |
|---|---|---|---|
| `columns` | `auto`, `1`, `2`, `3`, `4`, `6` | `auto` | Columns at full width. `auto` is 2 on a phone, 3 on a tablet, 4 on a desktop. Every setting drops to 2 on a narrow frame. |
| `controls` | `search`, `tags`, `sort`, `none` | `search,tags` | Which controls the viewer gets, comma-separated. `none` is a fixed gallery. |
| `title` | any text | none | A heading above the grid. |
| `description` | any text | none | One line under the heading. |
| `theme` | `light`, `dark`, `system` | `light` | Palette. `system` is the warm cream one, not an OS setting. |
| `bg` | `transparent` | opaque | Lets your page's own background show through. |
| `open` | `lightbox`, `tab`, `none` | `lightbox` | What a click does: a full-frame preview, a new tab on Google Drive, or nothing. |
| `height` | `fill`, `auto` | `fill` | `fill` scrolls inside the iframe. `auto` grows with the content — see below. |

A viewer's own search or tag choices can only **narrow** what you chose. Someone
handed an embed of one folder cannot browse out of it.

### Worked examples

One project folder, no controls, fixed 3 columns:

```
/embed?pathPrefix=dwp_Digital_Asset/dwp%20Projects/Thailand/Celes%20Asoke&controls=none&columns=3
```

Everything cleared for publication, newest first, searchable, on a dark page:

```
/embed?permission=granted&controls=search,sort&theme=dark&bg=transparent
```

Hospitality exteriors in Bangkok, 24 at a time:

```
/embed?studio=bangkok&core=Hospitality&tags=exterior&limit=24
```

---

## 4. Sizing the frame to its content

With `height=auto` the gallery posts its height to your page whenever it
changes. Listen for it and resize:

```html
<iframe id="dam" src="https://dwp-dam-s2r2rmdlzq-eu.a.run.app/embed?height=auto"
        width="100%" height="400" style="border:0" title="Digital Assets"></iframe>

<script>
  window.addEventListener("message", (event) => {
    if (event.origin !== "https://dwp-dam-s2r2rmdlzq-eu.a.run.app") return;
    if (event.data?.type !== "dwp-dam-embed:height") return;
    document.getElementById("dam").style.height = event.data.height + "px";
  });
</script>
```

Keep the `event.origin` check. Without `height=auto` no message is sent and the
gallery scrolls inside whatever height you gave the iframe.

---

## 5. What the viewer sees when they are not signed in

A card offering **Sign in with Google**. Selecting it opens a small Google
window; when they finish, it closes itself and the assets appear. Your page
never navigates away, and they never have to find Digital Assets in another tab.

The popup exists because Google sign-in cannot run inside an embedded page —
it needs a window of its own. That is a rule of the browser, not a limitation
of this embed.

Two things to expect:

- **On Safari, and often on Firefox**, one extra step appears after the popup
  closes: *"This browser needs one more permission before an embedded page can
  use the session"*, with a **Continue** button. Those browsers refuse to let an
  embedded page keep a session until the person asks for it explicitly, and that
  button is the standard way to ask. It is one click, once.
- **If popups are blocked**, the card says so and offers a new tab instead.

Also expected, and not a bug in your page: someone who has no Digital Assets
access at all cannot get past the card. Access is granted per person at the dwp
auth broker, and no embed can widen it.

---

## 6. When it does not work

| What you see | What it is |
|---|---|
| Blank frame; console mentions `frame-ancestors` or "refused to connect" | Framing has been restricted since this guide was written. Ask the Digital Assets owner to add your origin to `DAM_EMBED_ORIGINS`. |
| "Sign in to view these assets" | Expected — see section 5. The card signs them in on the spot. |
| "No assets match these filters" | The filters are right but nothing matches. Check the folder path's spelling, capitals and `%20`s against the folder tree in Digital Assets. |
| "These assets could not be loaded" | Digital Assets or Google Drive is unreachable. The Try again button re-runs it. |
| Grid appears, tiles stay grey | Google Drive has no thumbnail for those files (common for video and some PDFs). The name and badge row still tells the viewer what they are. |
| Everything is Light even with `theme=dark` | `theme` must be `light`, `dark` or `system`; anything else is ignored. |

---

## 7. What the gallery cannot do

Worth knowing before it goes in front of anyone. This section is about `/embed`;
the full app embedded at `/browse` can do everything it normally does.

- It cannot upload, delete, re-tag, change a permission, or export to Slides.
  Its session is accepted for reading and nothing else, so a page that framed it
  could not trick a viewer into a change they did not make.
- It cannot show assets to somebody without Digital Assets access.
- It cannot show anything to a page that frames it. A parent page cannot read
  across origins into a frame, so framing the gallery reveals nothing to the
  site doing the framing — only to the person looking at the screen.
- It carries `noindex`, so an embed URL never becomes a search result.

Assets marked **Internal** are shown to signed-in staff, with a red Internal
badge, exactly as they are in the app. If the host page is one that clients see,
add `permission=granted`.
