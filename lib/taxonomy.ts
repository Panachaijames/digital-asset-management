// dwp Global DAM — Sector & Sub-Sector taxonomy.
// Three levels: Macro Portfolio → Core Sector → Sub-Sector tags.
// This is the single source of truth used by the picker, the AI classifier,
// and the server-side validation of incoming uploads.

export interface CoreSector {
  name: string;
  subSectors: string[];
}

export interface MacroPortfolio {
  name: string;
  coreSectors: CoreSector[];
}

// One row of the editable Tag Settings table: Macro Portfolio → Core Sector →
// Sub-Sector tags. The DB-backed row set (lib/taxonomyStore.ts) is the live
// taxonomy; this type lives here so client components can share it without
// pulling in server-only code.
export interface TaxonomyRow {
  macro: string;
  core: string;
  tags: string[];
}

// Groups the flat row set into the MacroPortfolio[] tree shape the lookup
// helpers below consume. Rows sharing a macro name (case-insensitive) merge
// under the first row's casing.
export function rowsToTree(rows: TaxonomyRow[]): MacroPortfolio[] {
  const tree: MacroPortfolio[] = [];
  const byMacro = new Map<string, MacroPortfolio>();
  for (const row of rows) {
    const key = row.macro.toLowerCase();
    let macro = byMacro.get(key);
    if (!macro) {
      macro = { name: row.macro, coreSectors: [] };
      byMacro.set(key, macro);
      tree.push(macro);
    }
    macro.coreSectors.push({ name: row.core, subSectors: [...row.tags] });
  }
  return tree;
}

export const TAXONOMY: MacroPortfolio[] = [
  {
    name: "Lifestyle",
    coreSectors: [
      {
        name: "Hospitality",
        subSectors: [
          "Luxury Resort",
          "Urban Business Hotel",
          "Boutique & Lifestyle",
          "Serviced Apartments",
          "Eco-Lodge",
        ],
      },
      {
        name: "Food & Beverage",
        subSectors: [
          "Fine Dining",
          "Destination Bar",
          "All-Day Dining",
          "Cafe & Lounge",
          "Speakeasy",
        ],
      },
      {
        name: "Residential",
        subSectors: [
          "High-Rise Residential",
          "Super-Luxury Villas",
          "Showflat",
          "Co-Living",
          "Branded Residences",
        ],
      },
      {
        name: "Retail & Leisure",
        subSectors: [
          "Experiential Retail",
          "Wellness Spa",
          "Fitness & Sports Club",
          "Flagship Store",
          "Entertainment Hub",
        ],
      },
    ],
  },
  {
    name: "Workplace",
    coreSectors: [
      {
        name: "Corporate",
        subSectors: [
          "Global HQ",
          "Tech & Innovation Hub",
          "Financial Services",
          "Creative Studio",
          "Regional Office",
        ],
      },
      {
        name: "Co-Working",
        subSectors: ["Flexible Workspace", "Executive Club", "Incubator Space"],
      },
    ],
  },
  {
    name: "Community",
    coreSectors: [
      {
        name: "Healthcare",
        subSectors: [
          "Medical Center",
          "Wellness Retreat",
          "Patient-Centric Facility",
          "Specialized Clinic",
        ],
      },
      {
        name: "Education",
        subSectors: [
          "Higher Ed Campus",
          "K-12 School",
          "Learning Commons",
          "Research Lab",
          "Student Hub",
        ],
      },
      {
        name: "Civic & Cultural",
        subSectors: [
          "Public Realm",
          "Exhibition Space",
          "Mixed-Use Precinct",
          "Museum",
          "Community Center",
        ],
      },
    ],
  },
];

// --- Derived lookups -------------------------------------------------------
// Every helper takes an optional `taxonomy` tree so callers can pass the
// DB-backed, user-editable taxonomy (lib/taxonomyStore.ts). Omitting it falls
// back to the built-in defaults above.

export const MACRO_NAMES = TAXONOMY.map((m) => m.name);

// --- Primary sectors vs facets ---------------------------------------------
// The taxonomy mixes two very different kinds of macro portfolio:
//   • PRIMARY sectors — what a photograph is *of* (a hotel, an office, a
//     school, a person, an event). Exactly one primary macro + one of its core
//     sectors is an asset's primary classification (macro_portfolio/core_sector).
//   • FACETS — metadata *about* the asset that is not its subject: where it was
//     shot (Location Matrix), setting/climate, sustainability, rights,
//     lifecycle, AI provenance, etc.
// Only primary sectors may become macro_portfolio / core_sector. Facet terms
// are still applied as flat tags, but must NEVER be chosen as the primary
// classification — otherwise an image gets labelled by its location (in
// practice, by its folder name) instead of by what it depicts. This is exactly
// what put ~14k assets under "Location Matrix / Global Region / Australia".
// Matched case-insensitively; if you rename one of these macros in
// Settings → Tag Settings, update this list to match.
export const PRIMARY_MACRO_NAMES = [
  "Lifestyle",
  "Workplace",
  "Community",
  "Staff & Culture",
  "Brand Activation",
] as const;

const PRIMARY_MACRO_SET = new Set<string>(
  PRIMARY_MACRO_NAMES.map((n) => n.toLowerCase())
);

// True when `name` is a primary-sector macro (eligible to be macro_portfolio).
// Everything else in the taxonomy is a facet — tag-only.
export function isPrimaryMacro(name: string | null | undefined): boolean {
  return typeof name === "string" && PRIMARY_MACRO_SET.has(name.toLowerCase());
}

export function coreSectorsFor(
  macro: string | null | undefined,
  taxonomy: MacroPortfolio[] = TAXONOMY
): CoreSector[] {
  return taxonomy.find((m) => m.name === macro)?.coreSectors ?? [];
}

export function subSectorsFor(
  macro: string | null | undefined,
  core: string | null | undefined,
  taxonomy: MacroPortfolio[] = TAXONOMY
): string[] {
  return (
    coreSectorsFor(macro, taxonomy).find((c) => c.name === core)?.subSectors ??
    []
  );
}

export function macroForCore(
  core: string | null | undefined,
  taxonomy: MacroPortfolio[] = TAXONOMY
): string | null {
  for (const macro of taxonomy) {
    if (macro.coreSectors.some((c) => c.name === core)) return macro.name;
  }
  return null;
}

// Normalises a list of free-text tags: lower-cased, trimmed, leading '#' stripped,
// de-duplicated, non-empty, capped. Accepts anything (tampered/AI input) without throwing.
export function normalizeTags(input: unknown, max = 12): string[] {
  const arr = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t !== "string") continue;
    const tag = t.trim().replace(/^#+/, "").toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

// Derives a structured taxonomy selection from a flat tag list — the upload
// page's single tagging surface. Names are matched case-insensitively against
// the taxonomy; canonical casing is returned for the structured columns.
export function deriveSelectionFromTags(
  tags: string[],
  taxonomy: MacroPortfolio[] = TAXONOMY
): {
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
} {
  const lower = new Set(tags.map((t) => t.toLowerCase()));

  // Only PRIMARY sectors may drive macro/core. Facet macros (Location Matrix,
  // Climate, ...) are excluded here, so a photo in an "Australia" folder is
  // never classified as Location Matrix / Global Region — "australia" simply
  // stays a flat facet tag. See PRIMARY_MACRO_NAMES / isPrimaryMacro.
  const primary = taxonomy.filter((m) => isPrimaryMacro(m.name));

  let macro =
    primary.find((m) => lower.has(m.name.toLowerCase()))?.name ?? null;

  let core: string | null = null;
  for (const m of primary) {
    for (const c of m.coreSectors) {
      if (lower.has(c.name.toLowerCase())) {
        core = c.name;
        break;
      }
    }
    if (core) break;
  }

  // No explicit core-sector tag — infer it from the first sub-sector tag.
  if (!core) {
    outer: for (const m of primary) {
      for (const c of m.coreSectors) {
        for (const s of c.subSectors) {
          if (lower.has(s.toLowerCase())) {
            core = c.name;
            break outer;
          }
        }
      }
    }
  }

  // The core sector's parent always wins so the pair stays consistent.
  if (core) macro = macroForCore(core, primary);

  const sub_sectors = subSectorsFor(macro, core, taxonomy).filter((s) =>
    lower.has(s.toLowerCase())
  );

  return { macro_portfolio: macro, core_sector: core, sub_sectors };
}

// Normalises a raw (possibly AI-produced) selection to valid taxonomy values.
// Drops anything that isn't a real macro/core/sub, and repairs the macro from
// the core sector when they disagree. Returns a fully-consistent selection.
export function normalizeSelection(
  input:
    | {
        macro_portfolio?: string | null;
        core_sector?: string | null;
        sub_sectors?: string[] | null;
      }
    | null
    | undefined,
  taxonomy: MacroPortfolio[] = TAXONOMY
): {
  macro_portfolio: string | null;
  core_sector: string | null;
  sub_sectors: string[];
} {
  // Defensive: a tampered/stale client or a mis-shaped AI result may pass a
  // non-object or wrongly-typed fields (e.g. sub_sectors as a string). Never
  // throw — sanitise instead, so one bad item can't wipe a whole batch.
  const safe =
    input && typeof input === "object" ? input : ({} as Record<string, unknown>);

  const rawCore = (safe as { core_sector?: unknown }).core_sector;
  const rawMacro = (safe as { macro_portfolio?: unknown }).macro_portfolio;
  const rawSub = (safe as { sub_sectors?: unknown }).sub_sectors;

  // Only PRIMARY sectors may be the macro/core. A facet the model returned as
  // the primary classification (e.g. Location Matrix) is rejected to null here;
  // facet terms still reach the asset through preset_tags, validated separately.
  const primary = taxonomy.filter((m) => isPrimaryMacro(m.name));

  const core =
    typeof rawCore === "string" && macroForCore(rawCore, primary)
      ? rawCore
      : null;

  const macro = core
    ? macroForCore(core, primary)
    : typeof rawMacro === "string" && primary.some((m) => m.name === rawMacro)
    ? rawMacro
    : null;

  const valid = new Set(subSectorsFor(macro, core, taxonomy));
  const subInput = Array.isArray(rawSub) ? rawSub : [];
  const sub_sectors = subInput.filter(
    (s): s is string => typeof s === "string" && valid.has(s)
  );

  return { macro_portfolio: macro, core_sector: core, sub_sectors };
}
