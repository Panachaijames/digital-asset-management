# dwp Studio — interface system

A house interface language for dwp applications, derived from the StudioAI panel. Drop this file into any build — a Google AI Studio app, a Claude artifact, a React project — and instruct the builder to follow it. Every value below was read off the running StudioAI application, not designed from scratch, so an app built to this file will sit inside StudioAI without a seam.

**How to use it.** Paste the whole file, or paste Part 2 (tokens) and Part 8 (the instruction block) if the builder has a short context. Say: *"Follow the dwp Studio interface system in this file exactly. Use the tokens; do not introduce colours, sizes or radii outside them."*

---

## 1. The five rules

Everything else in this document follows from these. If a decision is not covered below, decide it by these.

1. **Warm, not cool.** The ground is an off-white with a yellow bias. There is no blue-grey anywhere in the neutral scale.
2. **Flat.** One hairline border does the work a shadow would do. Elevation is expressed by a border and a white fill, never by a drop shadow.
3. **Weight 500 is the emphasis.** Headings are medium, not bold. Bold appears only on the figure in a stat tile.
4. **12px is the working size.** Body, table cells, buttons and most labels are 12px. Larger type is rare and deliberate.
5. **Colour means something.** Neutral by default; a hue is a signal — on plan, attention, exception, information. Never decoration.

---

## 2. Tokens

Paste this block directly.

```css
:root {
  /* Surfaces */
  --ground:        #F7F7F5;  /* page background */
  --panel:         #FFFFFF;  /* cards, tables, bars */
  --fill-subtle:   #F1EFE8;  /* hover, table headers, inactive fills */
  --fill-quiet:    #F6F5F2;  /* zebra rows, disabled fields */
  --ink-solid:     #1A1A19;  /* selected pills, solid dark states */

  /* Borders — always 1px */
  --border:        #D9D7CE;  /* default: every card, table, input */
  --border-light:  #E9E7DF;  /* dividers inside a card, row rules */
  --border-strong: #BEBCB2;  /* focus, emphasis, chart reference lines */

  /* Text */
  --text-heading:  #1A1A19;
  --text:          #2C2C2A;  /* body, table cells */
  --text-second:   #4E4D49;  /* supporting text, idle controls */
  --text-muted:    #5F5E5A;  /* descriptions under a title */
  --text-label:    #8A8880;  /* uppercase micro-labels, column heads, axes */
  --text-invert:   #FFFFFF;

  /* Signal */
  --positive:      #159A6F;  /* on plan, complete, within budget */
  --positive-deep: #143D31;  /* solid positive fills, dark bars */
  --warning:       #A5680F;  /* attention, pending, forecast, primary action */
  --warning-deep:  #854F0B;
  --negative:      #7E2B25;  /* exception, overrun, critical, at risk */
  --alert:         #CC3A3A;  /* hard failure only — use sparingly */
  --info:          #2477CB;
  --info-tint:     #E6F1FB;

  /* Shape */
  --r-sm:  4px;   /* progress bars, tiny chips */
  --r:     8px;   /* buttons, inputs, icon squares, small cards */
  --r-lg:  12px;  /* panel cards, tables, tiles */
  --r-pill: 999px;

  /* Spacing — 4px base */
  --s-1: 4px;  --s-2: 6px;  --s-3: 8px;  --s-4: 12px;
  --s-5: 16px; --s-6: 20px; --s-7: 24px; --s-8: 32px; --s-9: 48px;

  /* Type */
  --font: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

Tailwind equivalent, if the project uses it:

```js
theme: {
  extend: {
    colors: {
      ground: '#F7F7F5', panel: '#FFFFFF',
      subtle: '#F1EFE8', quiet: '#F6F5F2', ink: '#1A1A19',
      line: { DEFAULT: '#D9D7CE', light: '#E9E7DF', strong: '#BEBCB2' },
      body: '#2C2C2A', second: '#4E4D49', muted: '#5F5E5A', label: '#8A8880',
      positive: { DEFAULT: '#159A6F', deep: '#143D31' },
      warning:  { DEFAULT: '#A5680F', deep: '#854F0B' },
      negative: '#7E2B25', alert: '#CC3A3A',
      info: { DEFAULT: '#2477CB', tint: '#E6F1FB' },
    },
    borderRadius: { DEFAULT: '8px', lg: '12px', xl: '12px', '2xl': '12px' },
    fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
    boxShadow: { xs: '0 1px 2px rgba(26,26,25,0.03)' },
  }
}
```

**Signal tints.** A signal colour is used at three strengths and no others: **5–8%** as a background, **20–30%** as a 1px border, **100%** as text or a solid fill.

---

## 3. Typography

Inter throughout. No second typeface. No monospace — set `font-variant-numeric: tabular-nums` globally so figures align in columns without one.

| Role | Size | Weight | Tracking | Colour |
|---|---|---|---|---|
| Page title | 20px | 500 | −0.5px | `--text-heading` |
| Panel heading | 18px | 500 | normal | `--text-heading` |
| Card heading | 13px | 500 | normal | `--text-heading` |
| Body, table cell, button | **12px** | 400 | normal | `--text` |
| Body emphasis | 12px | 500 | normal | `--text` |
| Micro-label, column head, eyebrow | 11px | 500 | +0.5px, uppercase | `--text-label` |
| Smallest label, chart axis | 10px | 500 | +0.6px, uppercase | `--text-label` |
| Stat figure | 20px | 700 | normal | `--text-heading` or signal |

Line height 1.4 for body, 1.2 for headings and figures.

**Never** set a heading above weight 500. **Never** use weight 600. Weight 700 appears only on a stat figure; 800 only on a hero figure in a portfolio header.

---

## 4. Layout and spacing

**The panel is fluid, not fixed.** It fills the space available with **32px padding** on all sides and no maximum width. Do not centre content in a narrow column.

- Vertical rhythm between major blocks: **24px**
- Gap between cards in a row: **16px**
- Padding inside a card: **20px** (16px for a dense card)
- Bottom of page: **48px** of clear space
- Small gaps inside a control: 6px or 8px

**Page header**, at the top of every screen, three parts stacked, followed by a `--border-light` rule and 20px of space:

1. **Eyebrow** — uppercase, 11px, weight 500, +0.5px, `--text-label`. Two or three words joined by a middle dot: `PROJECT CONTROLS · MULTI-DISCIPLINE WORKSPACE`
2. **Title** — a 20px outline icon, then the title at 20px weight 500, −0.5px
3. **Description** — one line, 12px, `--text-muted`

Actions sit to the right of the title on the same line. Nothing else goes inside the header block; it is text and one row of actions.

---

## 5. Components

### Card / panel
White, 1px `--border`, `--r-lg`, 20px padding, no shadow. Heading 13px/500 with a 16px outline icon to its left. Internal dividers `--border-light`.

### Stat tile
White, 1px `--border`, `--r-lg`, 20px padding. Left: a **36px square** at `--r`, filled with the relevant signal colour at 8%, holding a 16px outline icon. Right: uppercase 11px `--text-label`; below it the figure at 20px/700; below that a 12px `--text-muted` sub-line. When the tile reports an exception, the figure takes the signal colour.

Four tiles across is the standard row; `grid-cols-2 lg:grid-cols-4`, 16px gap.

### Buttons
| Variant | Fill | Text | Border |
|---|---|---|---|
| Primary | `--warning` | white | none |
| Secondary | white | `--text` | 1px `--border` |
| Tertiary | none | `--text-second` | none, underline on hover |
| Destructive | none | `--negative` | none |

All: `--r`, 12px weight 500, padding 8px 14px (compact: 6px 10px). Icon 14px, 6px gap.

### Pill group — for setting switches
Fully rounded. Active: solid `--ink-solid`, white text. Idle: transparent, 1px `--border`, `--text-second`. 12px weight 500, padding 6px 12px.

### Underlined tabs — for view switches
12px text, 24px apart, on a `--border-light` rule that runs the panel width. Active: `--text-heading` with a 2px `--warning` underline. Idle: `--text-second`.

*Use pills for states of one view; use tabs for different views of the same data. Never mix the two forms in one control.*

### Badge / status
Fully rounded, 10px uppercase weight 500 +0.6px, padding 2px 8px. Background signal at 5%, border 1px signal at 25%, text the signal colour.

### Inputs and selects
White, 1px `--border`, `--r`, 12px text, padding 8px 12px. Focus: border `--border-strong`. No glow, no coloured ring.

### Icons
One outline set, 1.5px stroke. 16px in body, 20px in page titles, 14px in buttons. `--text-second` unless carrying a signal.

---

## 6. Data display

### Tables
- **Header row**: `--fill-subtle`, 11px uppercase 500 +0.5px `--text-label`, 1px `--border` beneath
- **Body rows**: 12px `--text`, 12px vertical padding, 1px `--border-light` between, `--fill-subtle` on hover
- Numeric columns right-aligned, tabular figures. First column left-aligned
- One hairline around the table. No shadow, no heavy internal rules
- A totals row takes `--fill-subtle` and weight 500

### Progress
4px tall, `--r-sm`, track at `--border-light`, fill at the signal colour.

### Heatmap cells
Background: signal at 5–8%. Border `--border-light`. Value 11px `--text`, variance in `--positive` or `--negative`. Forecast or projected cells take `--fill-quiet` with `--text-label` and a 10px uppercase column marker.

---

## 7. Charts

Charts follow the same palette. No charting library's default colours.

- Ground white, no border. Gridlines `--border-light` at 25% opacity
- Axis labels 10px uppercase `--text-label`
- Reference lines 1px dashed `--border-strong` with an 11px label
- Threshold or exception bands: the signal colour at 4%
- Actual data solid at 1.5px; forecast or projected dashed at 1.5px
- A "today" or "now" marker: 1px solid `--negative` with the label in a small `--negative` pill
- **Categorical series**, in order: `--positive-deep`, `--warning-deep`, `--negative`, `--info`, `--positive`, `--warning`, then desaturated steps between them. Any series in an exception state takes `--negative` regardless of its position, so the eye finds the problem before it reads the legend
- Bars: `--positive-deep` by default, `--negative` when in exception, `--text-heading` for a summary or roll-up

Legends sit below the chart, 11px, with a 8px round swatch. A source note sits beneath in 11px `--text-label` stating what the figure is computed from.

---

## 8. Instruction block for a builder

Paste this alongside the tokens when briefing an AI builder.

```
Build this interface in the dwp Studio system.

Ground #F7F7F5. Cards white with a 1px #D9D7CE border, 12px radius, 20px padding,
and NO box-shadow. Panel padding 32px, fluid width, 24px between blocks,
16px between cards in a row.

Inter throughout, no monospace, font-variant-numeric: tabular-nums.
12px is the working size for body, table cells and buttons.
Headings are weight 500 — never bold. Weight 700 only on a stat-tile figure.
Micro-labels are 11px uppercase weight 500 with +0.5px tracking in #8A8880.

Every screen opens with a three-part header: an uppercase eyebrow in #8A8880,
a 20px weight-500 title with an outline icon, and a one-line description in #5F5E5A.
Actions go to the right of the title, never inside the header block.

Colour is a signal, never decoration:
  on plan / complete  #159A6F   solid fills #143D31
  attention / pending #A5680F   also the primary button fill
  exception / at risk #7E2B25
  informational       #2477CB   tint #E6F1FB
Use a signal at 5-8% for a background, 20-30% for a border, 100% for text.
No saturated blue, no pure red, no cool grey anywhere in the neutrals.

Buttons: primary solid #A5680F with white text; secondary white with a
1px #D9D7CE border; both 8px radius, 12px weight 500.
Pill groups for switching a setting — active solid #1A1A19, white text.
Underlined tabs for switching a view — active with a 2px #A5680F underline.

Tables: header row #F1EFE8 with 11px uppercase labels; rows separated by
1px #E9E7DF; numerics right-aligned; one hairline around the whole table.

Icons: one outline set, 1.5px stroke, 16px in body, in #4E4D49.
```

---

## 9. Never

- A drop shadow on a card, tile, table or button
- A monospace face, anywhere
- A heading heavier than weight 500
- Cool grey, slate or blue-grey in the neutral scale
- Saturated blue or pure red as a signal — the warm equivalents carry the same meaning more quietly
- A coloured focus ring or glow
- Two type sizes doing the same job on one screen
- Colour used to distinguish things that are not different in kind
- A control that states a state instead of changing it
- The same figure computed in two places

---

## 10. Applying this to an existing app

Run it as four passes, in this order, checking after each:

1. **Tokens.** Replace the palette and typography. Nothing else. Most of the change in feel happens here.
2. **Shape and elevation.** Radii to 8 / 12 / pill. Remove every shadow. Every border to 1px `--border`.
3. **Layout.** 32px panel padding, 24px rhythm, the three-part page header on every screen.
4. **Components.** Tiles, buttons, pills, tabs, tables, badges, inputs — one at a time, against Part 5.

Then the test that matters: open the app beside StudioAI at the same window width. Someone who did not build either should not be able to tell which parts came from which.

---

*Note (dwp-dam), 2026-09-07 — this file is SUPERSEDED for this app.* dwp-dam
now follows the **dwp.intelligence UI Standard**, the fleet standard, whose
operative spec is `docs/dwp_Intelligence_UI_Consistency_Review.md`. This file
is kept because the standard's hex values were read off it, and because §1 of
the review records where the two disagree: radius (8/12px here, **6px** in the
standard), the type scale (10/11/12/13/18/20px here, **12/14/16/20/24px** in
the standard), and the font (Inter here, Proxima Nova with an Inter fallback
in the standard — gap 2 is still open).

Two rules in this file no longer apply to dwp-dam. The **three-part page
header** with an uppercase eyebrow is replaced by the standard's title +
one-line description + one action. The **signal palette** here
(`positive`/`warning`/`negative`/`alert`/`info`) is replaced by the standard's
two: the accent `#A5680F`, and danger `#7E2B25`. The Light/Dark/Claude toggle
described in the previous note **stays**: Light and Dark carry the standard's
palettes, and "System" keeps this app's warm cream/coral one as a recorded
exception (the standard would have System follow the OS — gap 6).
