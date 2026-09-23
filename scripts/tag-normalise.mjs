// Make the tag classification CONSISTENT, deterministically.
//
// Three rounds of agents produced a good vocabulary and an inconsistent one.
// The auditor's findings were not disagreements about meaning — they were the
// same decision made two ways:
//
//     timber slatted ceiling -> material      slatted timber ceiling -> element
//     ceiling fan -> element                  ceiling fans -> furniture
//     sleek modern -> drop                    sleek modernism -> design-style
//     brick facade -> element                 red brick facade -> material
//
// Word order. A plural. A suffix. No amount of re-prompting fixes that class of
// error reliably, because it asks a language model to be perfectly consistent
// about something it has no reason to be consistent about. Code does it once.
//
// So: keep the agents' judgement, impose consistency mechanically.
//   1. the two OVERRIDES the audit proved were never applied
//   2. VIEW, which was filed exactly backwards
//   3. one written criterion for design-style vs drop, applied to bare and
//      compound forms alike, and in BOTH directions
//   4. equivalence classes — same words in any order, singular or plural, or
//      differing only by a curated synonym, get whatever the majority got
//
// Usage: node scripts/tag-normalise.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";

const pass2 = JSON.parse(readFileSync("scripts/tag-assignments-pass2.json", "utf8"));
const cat = new Map(pass2.map((a) => [a.tag, a.category]));
const before = { ...tally(cat) };
const moved = [];
const set = (tag, to, why) => {
  const from = cat.get(tag);
  if (from === to) return;
  cat.set(tag, to);
  moved.push({ tag, from, to, why });
};

const words = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const has = (t, list) => words(t).some((w) => list.some((x) => (x.endsWith("*") ? w.startsWith(x.slice(0, -1)) : w === x)));
const head = (t) => words(t).at(-1) ?? "";

// --- 0. what counts as naming a design language ------------------------------
// Declared first because it GATES the overrides below as well as deciding
// design-style vs drop further down. One list, one meaning, used twice.
const LANGUAGE = ["modern", "modernism", "modernist", "contemporary", "minimalist", "minimalism",
  "brutalist", "brutalism", "industrial", "scandinavian", "nordic", "japandi", "deco", "classical",
  "classic", "traditional", "heritage", "midcentury", "biophilic", "maximalist", "futuristic",
  "organic", "rustic", "coastal", "tropical", "bauhaus", "postmodern", "vernacular", "eclectic",
  "transitional", "neoclassical", "gothic", "colonial", "victorian", "baroque", "moorish", "zen",
  "functionalist", "functionalism"];   // the movement. bare "functional" is a quality, not a language.
// Nouns that turn a language word into an explicit style phrase: "biophilic
// design", "modernist architecture", "minimalist aesthetic".
const STYLE_HEAD = ["design", "architecture", "aesthetic", "aesthetics", "style", "styling"];

// A tag NAMES a design language when the language word is its head noun, or
// when a style head noun is qualified by one. That is the narrow case, and it
// is the only one allowed to shield a tag from the overrides — so
// "biophilic modernism" stays a style while "modern lighting" (head noun
// "lighting") and "planter boxes" (head noun "boxes") still get overridden by
// the thing they actually depict.
const namesLanguage = (t) =>
  LANGUAGE.includes(head(t)) ||
  (STYLE_HEAD.includes(head(t)) && words(t).slice(0, -1).some((w) => LANGUAGE.includes(w)));

// --- 1. the two overrides, which the audit proved were never applied --------
// Any luminaire or quality of illumination. "illuminated signage", "backlit
// signage" and "neon signage" sat in architectural-element; the thing being
// filtered for there is the light, not the sign.
// NOT bare "light" or "lit": in this vocabulary they are far more often a
// SHADE than a luminaire — "light wood flooring", "light tile flooring",
// "light timber". Including them made the modifier decide, which is the exact
// error this file exists to stop. Every entry below is unambiguously a fitting
// or a quality of illumination.
const LUMINAIRE = ["lights", "lighting", "lamp", "lamps", "pendant", "pendants",
  "downlight*", "spotlight*", "uplight*", "sconce", "sconces", "luminaire", "luminaires",
  "chandelier", "chandeliers", "led", "backlit", "illuminated", "neon", "troffer", "lantern", "lanterns"];
// Any plant, planting or planter. "landscaping", "palm trees", "manicured lawn"
// and "landscaped garden" were all sitting in setting.
// NOT "biophilic": it names a design philosophy, not a plant, and it is already
// in LANGUAGE. Leaving it here dragged "biophilic elegance", "biophilic luxury"
// and "biophilic urbanism" out of design-style on the strength of a modifier --
// the same error as bare "light" above.
const PLANTING = ["plant", "plants", "planting", "planter", "planters", "greenery",
  "landscap*", "tree", "trees", "lawn", "garden", "gardens", "foliage", "shrub*", "hedge", "hedges"];

// A planted space is still a space. Where the head noun names one of these, the
// planting is the adjective -- "landscaped courtyard" belongs in space-type and
// "landscaped walkway" in setting, exactly as they were filed.
// "garden" and "lawn" are deliberately NOT here: a courtyard garden IS a garden.
const SPACE_HEAD = ["courtyard", "walkway", "path", "pathway", "terrace", "balcony",
  "atrium", "plaza", "rooftop", "roof", "deck", "patio", "veranda", "lobby", "entrance",
  "forecourt", "driveway", "pool", "poolside", "street", "boulevard", "promenade"];

for (const tag of cat.keys()) {
  if (namesLanguage(tag)) continue;   // a style is a style, whatever it evokes
  if (has(tag, LUMINAIRE)) set(tag, "lighting", "override: luminaire");
  else if (has(tag, PLANTING) && !SPACE_HEAD.includes(head(tag))) set(tag, "sustainability", "override: planting");
}

// --- 2. view means VANTAGE POINT, not outlook --------------------------------
// Settled by the category's own seeded description in SCHEMA.sql:
//
//     'View', 'view', 'Interior, exterior, aerial, plan.', max_depth 1, EXCLUSIVE
//
// So View is where the camera stands, and one asset has exactly one -- which is
// why the category is exclusive and flat. It is NOT what can be seen out of the
// window. An earlier pass here read "head noun is the view" off the word alone
// and pulled "city view", "ocean view" and "panoramic city views" in; an asset
// can perfectly well show a city view AND an ocean view, so an exclusive
// category is the wrong home for them. They are outlooks: part of the setting.
//
// The vantage word has to be the HEAD NOUN, or qualify one ("aerial view").
// A vantage word used as a modifier does not make the tag a vantage point:
// "exterior courtyard" is a courtyard, "exterior signage" is signage and
// "aerial photography" is a photography style -- the seed lists "aerial" under
// Photography Style too. Letting the modifier decide is the same error that put
// "light wood flooring" in lighting.
const VANTAGE = ["exterior", "interior", "aerial", "elevation", "section", "overhead", "birds-eye", "birdseye"];
const PLAN_VIEW = /^(plan|plan view|floor plan|site plan|plan drawing)$/i;
const OUTLOOK_HEAD = ["view", "views", "vista", "vistas", "panorama", "panoramas", "outlook", "perspective"];
for (const tag of cat.keys()) {
  if (cat.get(tag) === "lighting" || cat.get(tag) === "sustainability") continue;
  const vantage = has(tag, VANTAGE);
  if (PLAN_VIEW.test(tag.trim()) || (vantage && (VANTAGE.includes(head(tag)) || OUTLOOK_HEAD.includes(head(tag))))) {
    set(tag, "view", "names where the camera stands");
  } else if (!vantage && OUTLOOK_HEAD.includes(head(tag))) {
    set(tag, "setting", "an outlook is part of the setting, not the vantage point");
  }
}

// --- 3. design-style vs drop, by ONE criterion, applied BOTH ways -----------
// The audit found ten pairs split by suffix alone. The criterion, applied the
// same way to "sleek modern" and "sleek modernism": a design-style tag must
// NAME A DESIGN LANGUAGE. A quality adjective on its own is not a language and
// nobody filters a library by "sleek".
//
// It has to run in BOTH directions or it cannot close those pairs. A demote-only
// pass leaves "sleek modern" in drop and "sleek modernism" in design-style --
// still split, by exactly the suffix the criterion is supposed to ignore.
//
// It arbitrates between design-style and drop and NOTHING else: a tag some
// earlier pass put in setting or sustainability was put there by a positive
// judgement about what it depicts, and that outranks a style word in it.
//
// has(), not namesLanguage(): namesLanguage is the strict head-noun test and
// exists only to STOP an override. Requiring the language to be the head noun
// here would demote 120 tags, among them "industrial chic", "modern luxury" and
// "art deco inspired" -- all real styles. Present anywhere is the right test.
for (const tag of [...cat.keys()]) {
  const now = cat.get(tag);
  if (now !== "design-style" && now !== "drop") continue;
  if (has(tag, LANGUAGE)) set(tag, "design-style", "names a design language");
  else set(tag, "drop", "no design language named, only a quality adjective");
}

// --- 4. equivalence classes -------------------------------------------------
// Two tags that are the same words in any order, singular or plural, must land
// in the same category. The class takes whatever the majority of its members
// got; ties go to the first alphabetically so the result is reproducible.
// Plurals alone are not enough. "marble countertop" sat in material while
// "marble counter" sat in furniture-fittings, and no amount of stemming unifies
// counter with countertop. These are the noun families this corpus actually
// uses in two forms, curated from the pairs the vocabulary contains -- not a
// general stemmer, which would over-merge.
//
// Deliberately absent: modern/modernism/modernist and functional/functionalist.
// Criterion 3 already settles those, and collapsing them here would erase the
// distinction it draws between a movement and an adjective.
const SYNONYM = new Map(Object.entries({
  countertop: "counter", roofing: "roof", flooring: "floor",
  paneling: "panel", panelling: "panel", ductwork: "duct",
  daylighting: "daylight", cityscape: "city", carpeted: "carpet",
  tiled: "tile", slatted: "slat", lined: "line", metallic: "metal",
  lighting: "light", planting: "plant",
}));
const singular = (w) => w.replace(/ies$/, "y").replace(/ses$/, "s").replace(/s$/, "");
const canon = (w) => SYNONYM.get(w) ?? w;
const key = (t) => words(t).map(singular).map(canon).sort().join(" ");
const classes = new Map();
for (const tag of cat.keys()) {
  const k = key(tag);
  if (!classes.has(k)) classes.set(k, []);
  classes.get(k).push(tag);
}
let split = 0;
for (const [, members] of classes) {
  if (members.length < 2) continue;
  const votes = {};
  for (const m of members) votes[cat.get(m)] = (votes[cat.get(m)] ?? 0) + 1;
  if (Object.keys(votes).length < 2) continue;
  split++;
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  for (const m of members) set(m, winner, `equivalence class: ${members.join(" / ")}`);
}

// --- report ------------------------------------------------------------------
function tally(m) { const t = {}; for (const v of m.values()) t[v] = (t[v] ?? 0) + 1; return t; }
const after = tally(cat);
console.log(`${cat.size} tags · ${moved.length} moved · ${split} equivalence classes were split and are now unified\n`);
console.log("category              pass2   normalised   change");
for (const k of Object.keys({ ...before, ...after }).sort()) {
  const b = before[k] ?? 0, a = after[k] ?? 0;
  console.log(`  ${k.padEnd(20)} ${String(b).padStart(5)} ${String(a).padStart(11)}   ${a - b > 0 ? "+" : ""}${a - b || ""}`);
}
const why = {};
for (const m of moved) why[m.why.split(":")[0]] = (why[m.why.split(":")[0]] ?? 0) + 1;
console.log("\nreason for every move:");
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

console.log("\nsample of what moved:");
for (const m of moved.slice(0, 12)) console.log(`  ${m.tag}  ${m.from} -> ${m.to}`);

if (process.argv.includes("--write")) {
  writeFileSync("scripts/tag-assignments-final.json",
    JSON.stringify([...cat].map(([tag, category]) => ({ tag, category }))), "utf8");
  writeFileSync("scripts/tag-moves.csv",
    ["tag,from,to,why"].concat(moved.map((m) =>
      [m.tag, m.from, m.to, m.why].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))).join("\n"), "utf8");
  console.log("\nwrote scripts/tag-assignments-final.json and scripts/tag-moves.csv");
}
