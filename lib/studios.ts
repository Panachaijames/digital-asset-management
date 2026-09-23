// dwp studios & project locations — the vocabulary behind the Studio filter.
//
// There is no studio column on an asset. A project's location lives in its
// Drive folder path, at a fixed depth:
//
//   dwp_Digital_Asset / <collection> / <LOCATION> / <project> / …
//   ^ level 0          ^ level 1       ^ level 2
//
// …where <collection> is one of "_OpenAsset Projects", "dwp Projects",
// "3D Projects" or "Marketing Hub" — those are the four that exist today, not
// a closed set.
//
// The match is on a whole path SEGMENT, which is what makes it exact rather
// than a guess: "/Thailand/" cannot be confused with the project folder
// "15-0060 Thailand Creative & Design Center (TCDC)". It is not pinned to
// level 2, and deliberately so — measured against the live library (34,437
// assets, 1,707 folder paths, 2026-09-07) every location name sits at level 2
// except "Vietnam", which also appears one deeper as
// "dwp Projects/VIETNAM/Vietnam/…". Matching at any depth picks that up
// instead of dropping it.
//
// Drive's casing is inconsistent (Thailand/THAILAND, Singapore/SINGAPORE,
// Vietnam/VIETNAM), so matching is case-insensitive, which merges each pair
// into one option.
//
// About 92% of the library sits under a location folder. The rest genuinely
// has none — "Marketing Hub/Marketing Requests", "dwp Projects/ARCHIVED",
// "_dwp Videos", "Staff Photo 2026", and the project folders that hang
// directly off "3D Projects" — and is deliberately left unclassified instead
// of being guessed at from project names.

export interface Studio {
  // Stable query-param value. Callers are matched against this list, so a
  // caller-supplied string never reaches a SQL pattern (see studioPathFilter).
  id: string;
  // The dwp studio that owns the location. Where no single studio does, this
  // is the region itself — Australia's folders cover the Sydney, Melbourne,
  // Brisbane, Adelaide and Newcastle studios and the path cannot tell them
  // apart, so it stays "Australia" rather than claiming one of them.
  label: string;
  // How Drive names the location, when that differs from the studio. The
  // folder only ever names a country or territory, so both are shown: someone
  // looking for "Dubai" and someone looking for "UAE" each find the option.
  region?: string;
  // Folder segments that mean this location, matched case-insensitively.
  folders: string[];
  // Set where none of `folders` exists in Drive yet. The entry is carried so
  // the picker starts offering the studio the moment someone creates the
  // folder; until then it is hidden, because choosing it could only ever
  // return nothing.
  pending?: boolean;
}

// Alphabetical by label — this is a vocabulary, not a ranking, and a native
// <select> jumps to an option by its first letter.
//
// A city label is used ONLY where dwp actually has a studio and it is the sole
// studio for that location folder. The studio names come from dwp's own
// "Studio Hub (Jurisdiction)" vocabulary (lib/taxonomyStore.ts): Bangkok,
// Dubai, Singapore, Ho Chi Minh City, Riyadh, Hong Kong, London, Sydney,
// Adelaide. Everywhere else the label is the location itself — a project in
// Malaysia is not delivered by a "Kuala Lumpur studio", and inventing one
// would put a place on screen that dwp does not have.
//
// Australia is the one location with several dwp studios (Sydney and Adelaide
// in the list above, plus Brisbane/Melbourne/Newcastle project codes in the
// data), and the folder path cannot say which — so it stays "Australia".
//
// London and Riyadh are real studios with no folder in Drive yet; they are
// carried here so the picker starts offering them the moment one appears
// (see `pending` and studiosPresentIn).
export const STUDIOS: Studio[] = [
  { id: "australia", label: "Australia", folders: ["Australia", "AUS_ARCHIVED"] },
  { id: "bahrain", label: "Bahrain", folders: ["Bahrain"] },
  { id: "bangkok", label: "Bangkok", region: "Thailand", folders: ["Thailand"] },
  { id: "china", label: "China", folders: ["China"] },
  { id: "dubai", label: "Dubai", region: "UAE", folders: ["UAE"] },
  {
    id: "ho-chi-minh-city",
    label: "Ho Chi Minh City",
    region: "Vietnam",
    folders: ["Vietnam"],
  },
  { id: "hong-kong", label: "Hong Kong", folders: ["Hong Kong"] },
  {
    id: "london",
    label: "London",
    region: "United Kingdom",
    folders: ["United Kingdom", "UK"],
    pending: true,
  },
  { id: "malaysia", label: "Malaysia", folders: ["Malaysia"] },
  { id: "myanmar", label: "Myanmar", folders: ["Myanmar"] },
  { id: "new-zealand", label: "New Zealand", folders: ["New Zealand"] },
  {
    id: "philippines",
    label: "Philippines",
    folders: ["Philippines", "Manila"],
  },
  {
    id: "riyadh",
    label: "Riyadh",
    region: "Saudi Arabia",
    folders: ["Saudi Arabia", "KSA"],
    pending: true,
  },
  { id: "singapore", label: "Singapore", folders: ["Singapore"] },
  {
    id: "united-states",
    label: "United States",
    folders: ["USA", "United States"],
  },
];

export function studioById(id: string | null | undefined): Studio | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  return STUDIOS.find((s) => s.id === key) ?? null;
}

// "Bangkok · Thailand", or just "Hong Kong" where the studio and the region
// are the same place.
export function studioOptionLabel(studio: Studio): string {
  return studio.region ? `${studio.label} · ${studio.region}` : studio.label;
}

// Escape the characters LIKE/ILIKE treats as wildcards, with a backslash —
// Postgres' default LIKE escape character. Without this "AUS_ARCHIVED" would
// also match "AUSxARCHIVED", because `_` matches any single character.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// PostgREST reads these as punctuation in an `or=(…)` expression, and an
// unquoted value cannot carry them (see studioPathFilter for why the values
// must stay unquoted). No dwp location folder contains one; the guard exists
// so that adding one later fails loudly here instead of silently emitting a
// filter that matches the wrong rows.
const OR_UNSAFE = /[",().:]/;

// A PostgREST `or=(…)` expression selecting every asset whose folder_path
// contains one of the studio's folders as a whole segment — for supabase-js's
// .or(). Two patterns per folder: the asset sits somewhere BELOW the location
// folder ("%/Thailand/%"), or directly INSIDE it ("%/Thailand"). The leading
// "/" is what makes this a segment match — it's why "/Thailand/" cannot match
// the project folder "15-0060 Thailand Creative & Design Center" — and it also
// means the drive-name segment at level 0 never matches.
//
// The values are deliberately NOT double-quoted. Measured against the live
// database: inside a quoted or() value PostgREST discards the backslash, so
// `\_` silently stays a wildcard, while an unquoted value honours it. (A
// quoted value would tolerate punctuation instead, which is what OR_UNSAFE
// above covers.) Spaces are fine unquoted — supabase-js encodes them.
//
// Nothing here is caller-supplied: `id` is looked up in STUDIOS and the folder
// names are this file's own constants, so no user string reaches the pattern.
export function studioPathFilter(id: string | null | undefined): string | null {
  const studio = studioById(id);
  if (!studio) return null;
  const clauses: string[] = [];
  for (const folder of studio.folders) {
    if (OR_UNSAFE.test(folder)) {
      // Skip rather than emit a filter that would match the wrong rows. A
      // studio whose every folder is skipped falls through to `null` below,
      // i.e. no studio filter at all, which is the safe direction.
      console.error(
        `studios: folder "${folder}" (studio "${studio.id}") contains a character that cannot be expressed in a PostgREST or() value; it will not be matched.`
      );
      continue;
    }
    const escaped = escapeLike(folder);
    clauses.push(`folder_path.ilike.%/${escaped}/%`);
    clauses.push(`folder_path.ilike.%/${escaped}`);
  }
  return clauses.length ? clauses.join(",") : null;
}

// The studio a folder path belongs to, or null when it sits outside every
// location folder. Same matching rule as studioPathFilter — case-insensitive,
// whole path segment, never the drive name at level 0. Used to refine results
// the client already holds (visual search), which never went through the SQL
// filter.
//
// One difference, for a path that nests two DIFFERENT location folders
// (".../Australia/Thailand/x", which does not occur in the library today):
// the SQL filter matches such a path under both studios, whereas this returns
// only the shallowest. Verified equivalent across all 1,707 folder paths the
// library actually has; if nested locations ever appear, this is the seam.
export function studioForPath(folderPath: string | null | undefined): Studio | null {
  if (!folderPath) return null;
  const segments = folderPath.split("/").slice(1);
  for (const segment of segments) {
    const name = segment.trim().toLowerCase();
    if (!name) continue;
    const hit = STUDIOS.find((s) =>
      s.folders.some((f) => f.toLowerCase() === name)
    );
    if (hit) return hit;
  }
  return null;
}

// The studios the picker should offer: those with a folder actually present in
// the Drive tree, so a pick can never come back empty-handed — including a
// `pending` studio whose folder has since been created.
//
// With no tree to go on (still loading, or /api/paths failed) we can't prove
// which folders exist, so fall back to the studios that are known to have
// assets. Offering the whole list instead would briefly show London and
// Riyadh, and picking one of those could only ever return nothing.
export function studiosPresentIn(paths: string[]): Studio[] {
  if (!paths.length) return STUDIOS.filter((s) => !s.pending);
  const present = new Set<string>();
  for (const path of paths) {
    for (const segment of path.split("/").slice(1)) {
      const name = segment.trim().toLowerCase();
      if (name) present.add(name);
    }
  }
  const offered = STUDIOS.filter((s) =>
    s.folders.some((f) => present.has(f.toLowerCase()))
  );
  // A tree with no location folder at all means we're looking at something
  // unexpected rather than at a library with no studios — same fallback as
  // for a missing tree.
  return offered.length ? offered : STUDIOS.filter((s) => !s.pending);
}
