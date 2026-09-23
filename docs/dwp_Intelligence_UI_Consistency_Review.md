# dwp.intelligence — UI consistency review

**Reviewed:** the running suite at `dwp-homestudioai-s2r2rmdlzq-eu.a.run.app` and the nine applications it links to, signed in as Scott Whittaker, 4 September 2026
**Reviewed against:** the brief's "dwp.intelligence UI Standard v1" (fixed placements, tokens, naming rules), with hex values taken from `dwp_Studio_UI_System.md`
**Out of scope:** the home page, as instructed. Third-party tools (HubSpot, Marq, Filecamp, Google Apps Script pages) are listed for completeness and not reviewed.
**Revision:** updated the same day for UI Standard v1.3 — the sidebar is collapsible to a 56px icon rail from a hamburger at the far left of the top bar; Feedback and the user photo with status sit at the top-right of the top bar on every page; every application offers Light, Dark and System appearance from the user menu.
**Companion file:** `dwp_Intelligence_UI_Status_Matrix.xlsx` — every app and sub-app, current state against proposed state, criterion by criterion.

---

## 1. Standard gap — read this first

The brief refers to a Project file called "dwp.intelligence UI Standard v1". No file under that name exists in the Project. The nearest documents are `dwp_Studio_UI_System.md` (August 2026, the interface language read off StudioAI) and `dwp_Fleet_Interface_Alignment.md` (September 2026, the `@dwp/ui` package plan).

The brief's bracketed values and the Studio system disagree in four places. This review follows the brief where it states a value and the Studio system where the brief left a bracket, and records the conflicts here rather than choosing silently.

| Item | Brief | Studio system | Used in this review | Needs a ruling |
|---|---|---|---|---|
| Font | Proxima Nova / fallback | Inter, "no second typeface" | Proxima Nova, Inter fallback | Yes — one face for the fleet |
| Type sizes | 12 / 14 / 16 / 20 / 24 | 10 / 11 / 12 / 13 / 18 / 20 | Brief's five sizes | Yes — the Studio 11px micro-label has no slot in the brief's scale |
| Radius | 6px | 8px controls, 12px cards | 6px | Yes |
| Accent | `--dwp-accent`, hex "in the standard file" | `#A5680F` (warm ochre) | `#A5680F` | Confirm |
| Sidebar | 240px, left, fixed | No sidebar defined; flagged as an open question in two prior reviews | 240px per brief | Confirm |
| Feedback icon | `[name]` | Not defined | `message-square` (Lucide) — the glyph the hub already uses | Yes |
| Tab height | `[height]` | Not defined | 40px | Yes |

Token hex values used throughout, mapped from the Studio system:

```
--dwp-bg       #F7F7F5   page ground
--dwp-surface  #FFFFFF   cards, sidebar, top bar
--dwp-text     #2C2C2A   body
--dwp-muted    #5F5E5A   secondary text
--dwp-accent   #A5680F   primary action, active tab
--dwp-border   #D9D7CE   every 1px rule
```

Recommendation: write these seven rulings into a file named `dwp_Intelligence_UI_Standard_v1.md` in the Project so the name in every brief resolves to a real document. Until then, every builder will read a different source.

---

## 2. Method

Each application was opened in the browser, signed in where sign-in was offered, and read two ways: computed styles off the rendered screen (sidebar width, fonts, weights, radii, box-shadows, button and card styles) and the shipped JavaScript bundle (Tailwind configuration, font imports, class frequency, navigation data). Three links returned 404 and could not be reviewed. Top 25 sits behind its own sign-in and was read from its bundle only.

The applications are separate deployments on separate origins with separate sign-ins. That is the root of most of what follows: there is no shared shell to inherit, so each has built its own.

---

## 3. Fleet findings

**Shell.** None of the twelve reviewed surfaces uses the standard shell. The hub (StudioAI, BD, IT+Apps) has a horizontal top nav and no sidebar. Six applications have a sidebar, at five different widths: Legal 224px, Finance 236px, HR 256px, Help Desk 256px, Marketing 320px, Proposal Maker 320px. Finance's sidebar is dark (`#1B2029`); the standard has no dark chrome. Forms has neither.

**Type.** Four families are in use — Inter (hub body, Finance body, HR, Legal, Forms, Help Desk), Montserrat (hub headings, Marketing throughout, Proposal Maker throughout), Space Grotesk (Finance headings), Proxima Nova (Top 25) — plus Material Symbols as an icon font in Marketing and Legal. Heading weights run from 300 (hub portal titles) to 900 (hub labels). The hub's bundle carries 411 `font-bold` and 19 `font-black` classes against 52 `font-medium`.

**Colour.** Six accents: indigo `#6366F1` (hub, Marketing), violet `#7C3AED` and `#6E44FF` (feedback buttons in the hub, Finance, Legal, Help Desk), blue `#1A73E8` and `#3B82F6` (Finance, Forms), gold `#B5883A` (Finance wordmark), orange `#EA7600` (Top 25), black (Help Desk, Proposal Maker primary). No application uses `--dwp-accent`. The hub's neutral scale is Tailwind slate — the cool blue-grey the Studio system rules out.

**Elevation.** Box-shadows visible on screen: hub 31, HR 27, Marketing 10, Proposal Maker 126, Legal 1, Help Desk 0. Card radii: hub 24px and 16px, HR 32px and 14px, Proposal Maker 16px, Legal and Help Desk 8px. The standard is 6px and no shadow.

**Feedback.** Five treatments. Hub, Finance and Proposal Maker: a violet circle top-right in the header. Legal and Help Desk: a floating violet circle bottom-right. Marketing: an indigo circle top-right. Forms: a blue speech-bubble icon with the text "Give Feedback". HR: none. The standard fixes it bottom-left of the sidebar, above the user menu, labelled "Feedback".

**User menu.** Top-right in every application that has one (hub, Finance, Legal, Marketing, Proposal Maker, Help Desk). HR puts the account at the bottom of the sidebar, which is the standard position, but as an email address and role badge rather than a menu. Forms has none.

**Search.** Finance, Legal and Help Desk place search top-right of the header; Proposal Maker places it in the sidebar; Marketing and the hub have none at the sub-app level. The standard places it in the top bar, right of the sub-app tabs.

**Sub-app navigation.** Nothing uses top-bar tabs for sub-apps. The hub uses card grids; Marketing, Finance, HR, Legal and Help Desk use sidebar lists; Legal uses underline tabs for regions (a view switch, which is correct) at 14px with a 2px indigo rule.

**Naming.** Against the four rules — title case, two words, no "AI", verb-first buttons, nouns consistent:

| Now | Rule broken | Proposed |
|---|---|---|
| StudioAI | "AI" suffix; no space | Studio |
| IT+Apps | Symbol in a name; ambiguous | IT |
| Help Desk (hub) / HelpDesk (IT card) / IT Helpdesk (tab title) / dwp. Help Desk (wordmark) | Four spellings | Help Desk |
| dwp.panda / dwp.HR Portal / Human Resources / PANDA | Four names for one app | HR |
| dwp.magic forms / Form (hub tab) | Two names; lower case | Forms |
| dwp. Proposal / Proposal Maker | Two names | Proposal Maker |
| Contracts (Legal title) / Contract Review (page) / Contract Revi… (truncated in sidebar) | Page title does not match sidebar label | Contract Review |
| Fee Registry (card) / FeeProposals (bundle) / Fee Calculation by Sector (description) | Three names | Fee Registry |
| Top 25 (hub) / Key Accounts (app's own sign-in) | Two names | Key Accounts |
| Hubspot | Product spelling is HubSpot | HubSpot |
| Hubspot Deals & Project | Ampersand; "Deal" outside the noun list | Leads and Projects |
| Filling System | Spelling | Filing System |
| dwp Feed / Internal Feed / Feed Archive | Sub-app group named for a mechanism | News |
| Buttons: "Open App ->", "View Dashboard ->", "Open Module", "Open Library", "View Calendar", "Full Reports", "New", "Import from PDF", "Create New Proposal", "Find Template", "New Ticket", "Request Time Off", "Ask HR Assistant" | Not verb-first, or arrows in labels, or two words where one does | "Open Fee Registry", "Open Key Accounts", "Open requests", "Open library", "Open calendar", "Open reports", "Create contract", "Import proposal", "Create proposal", "Find template", "Create ticket", "Request leave", "Ask HR" |

Two of the noun rules are not yet tested by any screen: no application says "Customer" or "Bid". "Opportunity" does not appear either; "Deal" does, once, in the Tools card.

**Copy.** Portal descriptions in the hub carry superlatives and marketing tone ("Comprehensive data set and analytics", "Centralized oversight"). American spellings appear throughout ("Visualization", "Centralized", "Organization"). The HR greeting ends in an exclamation mark.

**Broken links.** Quality (`dwp-intelligence-quality-…`), Fee Registry (`dwp-ai-fee-estimator-…`) and BD Data (`dwp-bd-data-…`) all return 404 from the hub. Two are labelled BETA and one is the Quality tab of StudioAI.

---

## 4. Deviations by application

Files are the shipped bundles; the hub's source was not available, so the "file/line" column names the bundle and the exact class string or data key that identifies the element in it. When the source repositories are opened, a search for the quoted string finds the line.

### 4.1 Hub — StudioAI, BD, IT+Apps (`dwp-homestudioai`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Shell | Horizontal top nav, no sidebar; content in a 1,240px centred column | Left sidebar 240px, top bar, fluid content area | `index-qwMhUZXc.js` — `nav` buttons `px-3 py-2 text-[14px] … rounded-t-lg border-b-2` |
| App name | Rendered as a 30–36px Montserrat weight-300 `h1` inside a card ("STUDIOAI", "Business Development", "IT+Apps") | Top-left of sidebar below the wordmark, 16px, `--dwp-text` | `font-montserrat` on portal `h1` |
| Sub-app navigation | Cards with `h3` groups (Visualization, Design Review, BIM, Quality, Tools) | Tabs in the top bar | `category:"StudioAISubTab"` seed data |
| Tabs (GM Control Room) | Pill buttons, `bg-[rgba(176,141,91,0.1)]` active, 13px weight 600 | Underline tabs, active `--dwp-accent`, 14px weight 500 | `"My Projects"`, `"Monthly CEO"`, `"Board Pack"` |
| Feedback button | Violet circle `bg-[#7c3aed] rounded-full shadow-sm hover:scale-110`, top-right, icon only, title "Give Feedback" | Bottom-left of sidebar, label "Feedback", `message-square`, ghost button | `className:"w-10 h-10 bg-[#7c3aed] rounded-full …"` |
| User menu | Top-right: name 12px bold, "Sign Out" 10px, avatar `rounded-xl shadow-sm` | Bottom of sidebar | `text-[12px] font-bold text-slate-800` |
| Theme toggle | Sun icon top-right; `darkMode:'class'` | Appearance control moves into the shell's user menu (Light · Dark · System); tokens swap, nothing else | `index.html` `tailwind.config` |
| Tokens | Tailwind config defines `dwp-primary #0f172a`, `dwp-secondary #64748b`, `dwp-accent #6366f1`, `dwp-border #e2e8f0` (slate/indigo); body `background:#f8f8fa` | The six `--dwp-*` tokens with Studio hex; no other colour | `index.html` lines 11–22 |
| Fonts | Inter body; Montserrat on 85 elements; Google Fonts loads both at 300–700 | One family; weights 400 and 500 only | `index.html` font `<link>`; `font-montserrat` |
| Type sizes | 9px (30 uses), 10px (108), 8px (7), 36px, 30px | 12 / 14 / 16 / 20 / 24 only | `text-[9px]`, `text-[10px]`, `text-[8px]` |
| Weights | `font-bold` 411, `font-black` 19, `font-semibold` 62 | 400 body, 500 emphasis | class frequency, bundle |
| Cards | `rounded-3xl` (24px) and `rounded-2xl` (16px), `shadow-sm`, `border-slate-100`, `p-6`/`p-8` | 6px radius, 1px `--dwp-border`, 16px padding, no shadow | `bg-white … rounded-3xl … shadow-sm border border-slate-100` |
| Portal cards (Visualization etc.) | 4px coloured left border per card (`borderLeft: 4px solid ${colour}`) | No decorative colour; surface card | `style:{borderLeft:\`4px solid ${Y}\`}` |
| Icon squares | `rounded-2xl shadow-xl … hover:-rotate-12` | No shadow, no rotation | `w-12 h-12 rounded-2xl shadow-xl` |
| Primary action | None on any portal screen | One primary, top-right of content area | — |
| Search | None on portal screens (only in Project List) | Top bar, right of tabs | — |
| Status badges | "BETA" pill `bg-amber-100` 9px weight 900 | Badge: accent at 5% fill, 25% border, 10px is outside the size scale — use 12px | `isBeta:!0` |
| Team strip | Staff photos and titles in every portal header | Not in the standard (gap 8) | `photoUrl` arrays |
| Link text | "Open App ->", "View Dashboard ->", "OPEN MANAGER", "APP OPEN" | Verb first, sentence case, no arrows | `linkText:"Open Module ->"` |
| Broken links | Quality, Fee Registry, BD Data → 404 | Remove or fix before restyle | `url:"https://dwp-intelligence-quality-…"` |

### 4.2 Finance (`dwp-finance`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Sidebar | 236px, dark `#1B2029`, gold wordmark "dwp. finance", numbered items 01–07 | 240px, `--dwp-surface`, 1px `--dwp-border` right rule; wordmark then app name "Finance" | body CSS vars `--ink`, `--charcoal`, `--gold` |
| Fonts | Inter body; Space Grotesk headings (`h1` 24px weight 600); `DashDisplay` custom face; monospace in 10 rules | One family; `h1` 20px weight 500 | `font-family:Space Grotesk,monospace` |
| Accent | Gold `#B5883A`; blue `#1A73E8` (15 uses); violet `#6E44FF` feedback; `#A855F7` | `--dwp-accent` only | stylesheet |
| Feedback | Violet circle top-right, `border-radius:50%`, shadow | Bottom-left of sidebar, "Feedback" | `[title="Feedback"]` |
| User menu | Avatar top-right | Bottom of sidebar | header |
| Sub-app name | "Finance" page title duplicates the app name | First item in top bar, e.g. "Overview" | `h1` |
| Sub-apps | Overview, Invoicing, Receivables, Payables, Resourcing, NSR & Profit, Finance — in the sidebar | Tabs in the top bar; "NSR & Profit" → "Profit" | sidebar list |
| Cards / link tiles | 10px radius, white, 1px `#EDEAE2` | 6px, 1px `--dwp-border` | `.tile` |
| Search | Top-right of header, "Search project code or name" | Top bar, right of tabs | header |
| Footer note | "Source: Google Sheets (live)" in the sidebar bottom | Sidebar bottom is reserved for Feedback and user menu; move under the table | sidebar |

### 4.3 HR (`dwp-panda`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Sidebar | 256px, `oklch(0.968 0.007 247.9)` (cool grey), items grouped Workspace / Resources, "Show all (9)" | 240px, `--dwp-surface`, hairline | shadcn theme vars |
| App name | "dwp.HR Portal / dwp.panda" with a "P" avatar; page reads "Human Resources"; tab title "dwp. PANDA" | "HR" under the wordmark | sidebar header |
| Active item | Solid indigo `oklch(0.511 0.262 277)` pill, 14px radius, white text | Text `--dwp-accent`, 6px, accent at 5% fill | nav |
| Buttons | "Ask HR Assistant" solid near-black, 12px weight 600, 14px radius; "Request Time Off" outlined pill | Primary `--dwp-accent`, 6px, 14px weight 500; one primary per screen | `button` |
| Cards | 32px and 14px radius, `shadow` (1px 3px + 1px 2px) | 6px, no shadow, 1px border | card |
| Heading | "Good afternoon, Scott!" `h1` 24px weight 700 with exclamation mark | Page title = sub-app name "Home", 20px weight 500; greeting as muted line if kept | `h1` |
| Feedback | None | Bottom-left of sidebar | — |
| User menu | Email and "Employee" badge at sidebar bottom | User menu control at sidebar bottom (position is right, component is not) | sidebar footer |
| Theme toggle | Moon icon top-right | Appearance moves into the user menu; app's own dark palette replaced by the token set | header |
| Team strip | Four HR staff photos in header card | Gap 8 | header |
| Sub-apps | Home, My Info, People, Requests, Holidays (sidebar) + 9 external links | Five tabs; external links in a "Links" card on Home | sidebar |

### 4.4 Legal (`dwp-legal-next-preview`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Sidebar | 224px white; "Modules" label; count badge "26" | 240px; no group label needed for four items | sidebar |
| App name | "dwp. legal" wordmark at 14px; no app name line | "Legal" under the wordmark | sidebar header |
| Sub-app name | Top bar reads "Contracts"; page `h1` reads "Contract Review"; sidebar reads "Contract Revi…" (truncated) | One name, "Contract Review", in the top bar first position | header + `h1` |
| Sub-apps | Contract Review, Contract Registry, Governance, Template Check — sidebar | Top-bar tabs | sidebar |
| Region tabs | Underline tabs 14px weight 500, active indigo `#4F46E5`-family rule | Correct pattern; active colour `--dwp-accent` | tab bar |
| Primary action | "+ New" solid indigo, top-right of content area — position correct | Label "Create contract"; fill `--dwp-accent` | `button` |
| Table header | 16px weight 700 uppercase | 12px weight 500 uppercase `--dwp-muted`, `--dwp-bg` fill | `th` |
| Status badges | Indigo/violet fills at 16px | Accent at 5% fill, 25% border | `.badge` |
| Feedback | Floating violet circle bottom-right | Bottom-left of sidebar | fixed button |
| User menu | Top-right with greeting and date | Bottom of sidebar | header |
| Icons | Material Symbols (icon font) | One outline SVG set (Lucide) | `<link>` Material+Symbols |
| Search | Top-right of the tab row — position correct | Placeholder "Search contracts" | input |

### 4.5 Marketing (`dwp-marketing-hub`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Font | Montserrat throughout (`tailwind.config fontFamily.sans`), Google Fonts 300–700 | Fleet font | `index.html` line 5–9 |
| Sidebar | 320px white, 17 items including a collapsible "dwp Feed" group with 5 children | 240px; sub-apps as tabs; no second level | sidebar |
| App name | "dwp.marketing" wordmark; page `h1` "Marketing" at 48px weight 400 | "Marketing" under the wordmark, 16px; page title 20px | `h1` |
| Active item | Indigo 10% fill, indigo text, 8px | `--dwp-accent` | nav |
| Accent | `#6366F1` 193 uses; `#E0821E` orange 93; `#007AFF` 113; `#1877F2`, `#0A66C2` social brand colours | `--dwp-accent`; social icons monochrome | bundle hex counts |
| Cards | 8px radius, 24px padding, 1px `#E0E0E0`, "Open Module" links | 6px, 16px padding, `--dwp-border` | card |
| Feedback | Indigo circle top-right, title "Feedback" | Bottom-left of sidebar | `[title="Feedback"]` |
| Theme toggle | Moon icon top-right | Appearance moves into the user menu; app's own dark palette replaced by the token set | header |
| Weights | `font-bold` 648, `font-semibold` 338, `font-extrabold` 11 | 400 / 500 | bundle |
| Shadows | `shadow-sm` 133, `shadow-md` 50, `shadow-2xl` 20 | None except menus | bundle |
| Icons | Material Symbols Outlined | Lucide | `<link>` |
| Team strip | Marketing manager photo top-right of page | Gap 8 | header |
| Sub-app labels | "Request & Planning", "Content & Assets", "Access Control", "dwp Feed" | "Requests", "Assets", "Access", "News" | nav data |

### 4.6 Forms (`dwp-magic-forms`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Shell | None — a single centred card on a blue-grey gradient (`linear-gradient(135deg,#F8FAFC,#E2E8F0)`) | Sidebar, top bar, content area | `body` |
| App name | "dwp.magic forms" as a 24px heading | "Forms" | `h1` |
| Function chips | Eight pills, each a different saturated colour (`#F44336`, `#FFEB3B`, `#BA68C8`…), active `#3B82F6` | Pill group: active `--dwp-text` solid, idle 1px border; no per-item colour | chip buttons |
| Primary | "Find Template" `#3B82F6`, 8px | "Find template", `--dwp-accent`, 6px | `button` |
| Feedback | Blue speech-bubble icon + "Give Feedback" text, top-right | Bottom-left of sidebar | `a` |
| User menu | None | Bottom of sidebar | — |

### 4.7 Help Desk (`it-helpdesk-hub`)

Closest to the standard: warm neutrals (`#F7F3EC` ground, `#E6E1D7` border), Inter, no shadows, 8px cards, sidebar with a primary action, filter pills as pill group.

| Element | Now | Should | File / location |
|---|---|---|---|
| Sidebar | 256px, `#F0ECE5` fill | 240px, `--dwp-surface` | sidebar |
| App name | "dwp. Help Desk" as one string | Wordmark, then "Help Desk" beneath | sidebar header |
| Primary action | "New Ticket" solid `#262626`, 6px, in the sidebar top | "Create ticket", `--dwp-accent`, top-right of content area | sidebar button |
| Sub-apps | Dashboard, My Tickets, Reports — sidebar | Top-bar tabs | sidebar |
| "Home" chip | A "Home" pill beside the page title (link back to hub) | Belongs in the wordmark or an app switcher (gap 7) | header |
| Stat tiles | Correct structure; icon square uses tinted greens/indigo | Icon square tint `--dwp-accent` at 8% | tiles |
| Feedback | Floating violet circle `#4F46E5` bottom-right | Bottom-left of sidebar | fixed button |
| User menu | Avatar top-right | Bottom of sidebar | header |
| Type | 16px base | 14px body, 12px labels | `body` |

### 4.8 Proposal Maker (`proposal-maker`)

| Element | Now | Should | File / location |
|---|---|---|---|
| Font | Montserrat (+ Noto Sans SC) | Fleet font | `body` |
| Sidebar | 320px, translucent white, folder tree by year (2026 / 2025 / Unidentified) with counts | 240px; the tree is content, not chrome — move into the content area's left column | sidebar |
| App name | "dwp. Proposal" wordmark; tab title "dwp. Proposal"; hub calls it "Proposal Maker" | "Proposal Maker" under the wordmark | header |
| Primary actions | Three: "Import from PDF" (violet), "Create Collateral" (outlined), "Create New Proposal" (black) | One primary "Create proposal", two secondary; verb-first | header buttons |
| Cards | 16px radius, 24px padding, 126 shadows on screen | 6px, 16px, none | project cards |
| Feedback | Violet circle top-right, "Give Feedback" | Bottom-left of sidebar | `[title="Give Feedback"]` |
| Theme toggle | Sun icon top-right | Appearance moves into the user menu; app's own dark palette replaced by the token set | header |
| Search | In the sidebar top | Top bar, right of tabs | sidebar input |
| Status badges | "DRAFT", "ISSUE 01" grey pills 9px | 12px, accent tint | badge |
| "Home" button | Outlined "Home" beside wordmark | App switcher (gap 7) | header |

### 4.9 Top 25 / Key Accounts (`dwp-top25-hubspot`) — bundle read only

| Element | Now | Should | File / location |
|---|---|---|---|
| Name | Sign-in reads "dwp.intelligence Key Accounts"; hub reads "Top 25" | Key Accounts (both) | sign-in card |
| Font | Proxima Nova, Inter fallback — the only app on the brief's font | Keep; confirm as fleet font (gap 2) | `body` |
| Accent | Orange `#EA7600` (20), blue `#1A73E8` (15) | `--dwp-accent` | bundle |
| Weights | `font-bold` 1,127, `font-semibold` 311, `font-extrabold` 72 | 400 / 500 | bundle |
| Shadows | `shadow-sm` 215, `shadow-md` 41 | None | bundle |
| Radius | `rounded-md` 555 (6px — correct), `rounded-full` 168 | 6px | bundle |

---

## 5. Corrected code

React with Tailwind, matching the hub's stack. Tokens are CSS custom properties named exactly as the brief; Tailwind exposes them so no component carries a hex. Six files make the shell; every screen is `<AppShell>` with a `<PageHeader>` and content.

### 5.1 `tailwind.config.js`

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    // No `extend`: the standard's palette replaces Tailwind's, so slate, indigo
    // and the rest are not available to reach for.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      bg:      'var(--dwp-bg)',
      surface: 'var(--dwp-surface)',
      text:    'var(--dwp-text)',
      muted:   'var(--dwp-muted)',
      accent:  'var(--dwp-accent)',
      border:  'var(--dwp-border)',
      danger:  'var(--dwp-danger)',
      'on-accent': 'var(--dwp-on-accent)',
      white:   '#FFFFFF',
    },
    fontFamily: {
      sans: ['"Proxima Nova"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
    },
    fontSize: {
      xs:   ['12px', { lineHeight: '16px' }],
      sm:   ['14px', { lineHeight: '20px' }],
      base: ['16px', { lineHeight: '24px' }],
      lg:   ['20px', { lineHeight: '28px' }],
      xl:   ['24px', { lineHeight: '32px' }],
    },
    fontWeight: { normal: '400', medium: '500' },
    spacing: {
      0: '0', 1: '4px', 2: '8px', 3: '12px', 4: '16px',
      6: '24px', 8: '32px', 12: '48px',
      sidebar: '240px', topbar: '56px', tab: '40px',
    },
    borderRadius: { none: '0', DEFAULT: '6px', full: '9999px' },
    borderWidth: { DEFAULT: '1px', 0: '0', 2: '2px' },
    boxShadow: {
      none: 'none',
      menu: '0 4px 12px rgba(26, 26, 25, 0.08)', // the one permitted shadow
    },
  },
  plugins: [],
};
```

### 5.2 `src/styles/tokens.css`

```css
:root {
  --dwp-bg:      #F7F7F5;
  --dwp-surface: #FFFFFF;
  --dwp-text:    #2C2C2A;
  --dwp-muted:   #5F5E5A;
  --dwp-accent:  #A5680F;
  --dwp-border:  #D9D7CE;
  --dwp-on-accent: #FFFFFF;
  --dwp-danger:  #7E2B25;
}

/* Dark appearance: colour tokens only. Stamped as data-theme on <html>; System stamps nothing. */
:root[data-theme="dark"] {
  --dwp-bg:#1A1A19; --dwp-surface:#232321; --dwp-text:#EDEBE4; --dwp-muted:#A3A19A;
  --dwp-accent:#C98A2E; --dwp-on-accent:#1A1A19; --dwp-border:#3A3935; --dwp-danger:#D0655C;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --dwp-bg:#1A1A19; --dwp-surface:#232321; --dwp-text:#EDEBE4; --dwp-muted:#A3A19A;
    --dwp-accent:#C98A2E; --dwp-on-accent:#1A1A19; --dwp-border:#3A3935; --dwp-danger:#D0655C;
  }
}

html { font-variant-numeric: tabular-nums; }
body { @apply bg-bg text-text font-sans text-sm antialiased; }
```

### 5.3 `src/shell/AppShell.jsx`

```jsx
import { NavLink } from 'react-router-dom';
import Wordmark from './Wordmark';
import TopBar from './TopBar';

/**
 * The one shell. Every screen except the home page renders inside it.
 *
 * app       { name, items:[{label, to}] }   — sidebar entries (core-app level)
 * subApp    string                            — first item in the top bar
 * tabs      [{label, to}]                     — sibling sub-apps, as tabs
 * search    { placeholder, onChange }         — optional
 * user      { name, photoUrl, status }        — status: available | away | dnd | offline
 */
export default function AppShell({ app, subApp, tabs, search, user, children }) {
  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="flex w-sidebar shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-4 pt-4 pb-3">
          <Wordmark />
          <div className="mt-2 text-base font-medium text-text">{app.name}</div>
        </div>

        <nav className="flex-1 px-2">
          {app.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded px-2 py-2 text-sm ${
                  isActive ? 'bg-accent/5 font-medium text-accent' : 'text-text hover:bg-bg'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar subApp={subApp} tabs={tabs} search={search} user={user} />
        <main className="flex-1 p-8 pb-12">{children}</main>
      </div>
    </div>
  );
}
```

### 5.4 `src/shell/TopBar.jsx`

```jsx
import { NavLink } from 'react-router-dom';
import { Search, MessageSquare } from 'lucide-react';
import UserMenu from './UserMenu';

const statusClass = {
  available: 'bg-accent',
  away:      'bg-muted',
  dnd:       'bg-danger',
  offline:   'bg-border',
};

/** v1.1: Feedback and the user's photo sit at the far right of the top bar on every page. */
export default function TopBar({ subApp, tabs = [], search, user }) {
  return (
    <header className="flex h-topbar items-stretch border-b border-border bg-surface px-8">
      <div className="flex items-center pr-6 text-base font-medium text-text">{subApp}</div>

      <nav className="flex items-stretch gap-6" aria-label="Sub-apps">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `flex h-tab items-center self-center border-b-2 text-sm ${
                isActive
                  ? 'border-accent font-medium text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {search && (
        <label className="ml-6 flex items-center gap-2 self-center rounded border border-border bg-surface px-3 py-2 text-sm text-muted focus-within:border-text">
          <Search size={16} strokeWidth={1.5} />
          <input
            type="search"
            placeholder={search.placeholder}
            onChange={(e) => search.onChange(e.target.value)}
            className="w-64 bg-transparent text-text outline-none placeholder:text-muted"
          />
        </label>
      )}

      <div className="ml-auto flex items-center gap-4 self-center">
        <a
          href={import.meta.env.VITE_FEEDBACK_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text hover:bg-bg"
        >
          <MessageSquare size={16} strokeWidth={1.5} />
          Feedback
        </a>
        <UserMenu
          trigger={
            <span className="relative inline-block h-8 w-8 rounded-full bg-border">
              {user?.photoUrl && (
                <img src={user.photoUrl} alt={user.name} className="h-8 w-8 rounded-full object-cover" />
              )}
              <i
                aria-label={`Status: ${user?.status ?? 'offline'}`}
                className={`absolute -bottom-px -right-px h-2 w-2 rounded-full ring-2 ring-surface ${statusClass[user?.status ?? 'offline']}`}
              />
            </span>
          }
        />
      </div>
    </header>
  );
}
```

### 5.5 `src/components/PageHeader.jsx`

```jsx
/** Title matches the sidebar label exactly. One primary action, top-right. */
export default function PageHeader({ title, description, action }) {
  return (
    <div className="mb-6 flex items-start justify-between border-b border-border pb-4">
      <div>
        <h1 className="text-lg font-medium text-text">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
```

### 5.6 `src/components/Button.jsx`

```jsx
const variants = {
  primary:   'bg-accent text-on-accent hover:opacity-90',
  secondary: 'bg-surface text-text border border-border hover:bg-bg',
  ghost:     'bg-transparent text-muted hover:text-text',
  danger:    'bg-transparent text-text border border-border hover:border-text', // no red token in the standard — see gap 10
};

export default function Button({ variant = 'secondary', icon: Icon, children, ...props }) {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-medium ${variants[variant]}`}
      {...props}
    >
      {Icon && <Icon size={16} strokeWidth={1.5} />}
      {children}
    </button>
  );
}
```

### 5.7 `src/components/Card.jsx`

```jsx
export default function Card({ title, children, className = '' }) {
  return (
    <section className={`rounded border border-border bg-surface p-4 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-medium text-text">{title}</h2>}
      {children}
    </section>
  );
}
```

### 5.8 Example — BD, Proposal Maker screen, rebuilt on the shell

```jsx
import { Plus } from 'lucide-react';
import AppShell from '../shell/AppShell';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import Card from '../components/Card';

const BD = {
  name: 'BD',
  items: [
    { label: 'Proposals', to: '/bd/proposals' },
    { label: 'Leads',     to: '/bd/leads' },
    { label: 'Pipeline',  to: '/bd/pipeline' },
  ],
};

const proposalTabs = [
  { label: 'Proposal Maker', to: '/bd/proposals/maker' },
  { label: 'Fee Registry',   to: '/bd/proposals/fees' },
  { label: 'Fee Approval',   to: '/bd/proposals/approval' },
];

export default function ProposalMaker() {
  return (
    <AppShell
      app={BD}
      subApp="Proposal Maker"
      tabs={proposalTabs}
      search={{ placeholder: 'Search proposals', onChange: () => {} }}
    >
      <PageHeader
        title="Proposal Maker"
        description="117 proposals"
        action={<Button variant="primary" icon={Plus}>Create proposal</Button>}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Riverside Workplace HQ">
          <p className="text-sm text-muted">Meridian Property Group · Bangkok</p>
        </Card>
      </div>
    </AppShell>
  );
}
```

What changed from the running screen: the project tree left the sidebar and becomes a filter inside the content area; three header buttons became one primary and two secondaries; the violet feedback circle becomes the shell's "Feedback" button at the top-right of the top bar beside the user's photo and status dot; the theme toggle and "Home" chip are gone because the wordmark opens the app switcher; every hex is a token.

---

## 6. Standard gap notes

Each is a question the standard does not answer today. None is resolved here.

**Gap 1 — the file.** "dwp.intelligence UI Standard v1" does not exist in the Project. Propose: create it from the brief plus the seven rulings in §1.

**Gap 2 — font.** Brief says Proxima Nova; Studio system says Inter and forbids a second face. Only Top 25 uses Proxima Nova today. Propose: rule once, for the fleet. Proxima Nova is the brand face and is licensed; Inter is free and already on nine of twelve apps.

**Gap 3 — radius.** Brief 6px; Studio 8px controls / 12px cards. Propose: 6px throughout, as the brief states, and amend the Studio file so the two agree.

**Gap 4 — feedback icon.** Bracketed in the brief. Propose `message-square` from Lucide, the glyph already in the hub, Finance and Proposal Maker.

**Gap 5 — tab height.** Bracketed. Propose 40px in a 56px top bar.

**Gap 6 — dark mode.** Ruled in Standard v1.2: every application offers Light, Dark and System from the user menu, stored per user; only the colour tokens change. The four existing toggles move into the shell's user menu and their local palettes are dropped.

**Gap 7 — moving between core apps.** The brief forbids a second sidebar and fixes the sidebar to one app, but says nothing about how a user gets from BD to Finance. The hub uses a top nav; Help Desk and Proposal Maker add a "Home" chip. Propose: the dwp. wordmark opens an app switcher menu (the `AppSwitcher` in `dwp_Fleet_Interface_Alignment.md`), and that menu is the one place shadows are allowed.

**Gap 8 — team strips.** Every hub portal, HR and Marketing show staff photos and titles in the header. The standard's header is title, description, one action. Propose: a "Team" card in the content area, or drop them.

**Gap 9 — external sub-apps.** Some sub-apps are other origins (HubSpot, Marq, Google Apps Script). A top-bar tab that leaves the shell breaks the pattern. Propose: external destinations are secondary buttons in a "Links" card, never tabs, and carry the `external-link` icon.

**Gap 10 — danger colour.** The brief lists a danger button but the six tokens have no red. Propose: add `--dwp-danger #7E2B25` (the Studio system's exception colour) as a seventh token.

**Gap 11 — icon set.** Not named. Marketing and Legal use Material Symbols; the rest use Lucide or inline SVG. Propose: Lucide, 1.5px stroke, 16px in body and 20px in page titles.

**Gap 12 — status badges.** The brief lists inputs, tables, modals and toasts "as defined in the standard" but no badge, and every app has one. Propose: accent at 5% fill, 25% border, 12px weight 500, sentence case.

**Gap 13 — sub-app name and page title.** The brief says the sub-app name is the first top-bar item and that page titles match the sidebar label. When the sidebar shows core-app items and the page is a sub-app, the two rules point at different strings. Propose: page title = sub-app name; the sidebar item is the parent and is shown active.

---

## 7. Order of work

Fix what is broken before restyling it: the three 404s (Quality, Fee Registry, BD Data). Then settle the thirteen gaps in one sitting — most are a sentence each. Then ship the shell as the `@dwp/ui` package the Fleet paper describes, and migrate in this order: Help Desk (nearest, a day), Legal (structure right, tokens wrong), Finance, HR, Marketing, Proposal Maker, the hub portals last because they change the most and are where users start.

Nothing here changes what any application does. Routes, data and behaviour are untouched.
