import { supabaseAdmin } from "@/lib/supabase";
import {
  rowsToTree,
  type MacroPortfolio,
  type TaxonomyRow,
} from "@/lib/taxonomy";

export type { TaxonomyRow };

// DB-backed, editable taxonomy — the unified three-level vocabulary shown in
// Settings → Tag Settings: Macro Portfolio → Core Sector → Sub-Sector tags.
// One TaxonomyRow per (macro, core) pair; the whole set is what the upload
// chips, the AI classifier, and deriveSelectionFromTags run on.
//
// Storage: we can't run DDL against Supabase from the app, so instead of a
// new table the row set is persisted INSIDE common_dam_presets as a reserved
// group ("__taxonomy__") holding an ASCII JSON document split across rows of
// ≤80 characters (the app already writes 80-char tags, so that width is safe
// whatever the column type is). Preset helpers filter reserved groups out,
// so external /api/v1/presets consumers never see these rows.

const TAXONOMY_GROUP = "__taxonomy__";
const CHUNK_SIZE = 80;

// The default vocabulary: the original built-in sector taxonomy plus the
// preset facets expanded into full rows. Reset restores exactly this.
export const DEFAULT_TAXONOMY_ROWS: TaxonomyRow[] = [
  { macro: "Lifestyle", core: "Hospitality", tags: ["Luxury Resort", "Urban Business Hotel", "Boutique & Lifestyle", "Serviced Apartments", "Eco-Lodge"] },
  { macro: "Lifestyle", core: "Food & Beverage", tags: ["Fine Dining", "Destination Bar", "All-Day Dining", "Cafe & Lounge", "Speakeasy"] },
  { macro: "Lifestyle", core: "Residential", tags: ["High-Rise Residential", "Super-Luxury Villas", "Showflat", "Co-Living", "Branded Residences"] },
  { macro: "Lifestyle", core: "Retail & Leisure", tags: ["Experiential Retail", "Wellness Spa", "Fitness & Sports Club", "Flagship Store", "Entertainment Hub"] },
  { macro: "Workplace", core: "Corporate", tags: ["Global HQ", "Tech & Innovation Hub", "Financial Services", "Creative Studio", "Regional Office"] },
  { macro: "Workplace", core: "Co-Working", tags: ["Flexible Workspace", "Executive Club", "Incubator Space"] },
  { macro: "Community", core: "Healthcare", tags: ["Medical Center", "Wellness Retreat", "Patient-Centric Facility", "Specialized Clinic"] },
  { macro: "Community", core: "Education", tags: ["Higher Ed Campus", "K-12 School", "Learning Commons", "Research Lab", "Student Hub"] },
  { macro: "Community", core: "Civic & Cultural", tags: ["Public Realm", "Exhibition Space", "Mixed-Use Precinct", "Museum", "Community Center"] },
  { macro: "Staff & Culture", core: "Role Seniority", tags: ["C-Suite", "Director", "Regional Head", "Senior Designer", "Design Principal", "Support Team"] },
  { macro: "Staff & Culture", core: "Function / Group", tags: ["Design Architecture", "Interior Design", "Business Development", "AI & Technology Taskforce", "HR & Admin"] },
  { macro: "Staff & Culture", core: "Portrait Style Variant", tags: ["Formal Studio White", "Casual Environmental", "On-Site Context", "Studio At Work"] },
  { macro: "Brand Activation", core: "Event Typology", tags: ["Industry Panel", "Design Award Gala", "Keynote Speech", "Studio Anniversary", "Client Networking", "Workshop"] },
  { macro: "Brand Activation", core: "Social Content Format", tags: ["Instagram Reel Asset", "LinkedIn Carousel", "Video Thumbnail", "Infographic", "Event Banner"] },
  { macro: "Location Matrix", core: "Global Region", tags: ["APAC", "MENA", "UK & Europe", "Australia"] },
  { macro: "Location Matrix", core: "Studio Hub (Jurisdiction)", tags: ["Bangkok", "Dubai", "Singapore", "Ho Chi Minh City", "Riyadh", "Hong Kong", "London", "Sydney", "Adelaide"] },
  { macro: "Location Matrix", core: "Climate / Setting Context", tags: ["Urban High-Dense", "Tropical Waterfront", "Desert Arid", "Alpine / Ski", "Coastal", "Historic Fabric"] },
  { macro: "Project Excellence", core: "Global Flagship", tags: ["Global Flagship"] },
  { macro: "Project Excellence", core: "Award Winner", tags: ["Award Winner"] },
  { macro: "Project Excellence", core: "Press Featured", tags: ["Press Featured"] },
  { macro: "Sustainability & Wellness", core: "Biophilic Design", tags: ["Biophilic Design"] },
  { macro: "Sustainability & Wellness", core: "Net-Zero Carbon", tags: ["Net-Zero Carbon"] },
  { macro: "Sustainability & Wellness", core: "Institutional Standard", tags: ["Institutional Standard"] },
  { macro: "Digital Innovation", core: "AI-Accelerated Workflow", tags: ["AI-Accelerated Workflow"] },
  { macro: "Digital Innovation", core: "Advanced 3D Visualisation", tags: ["Advanced 3D Visualisation"] },
  { macro: "Digital Innovation", core: "Smart Building", tags: ["Smart Building"] },
  { macro: "Marketing Performance", core: "Top Social Performer", tags: ["Top Social Performer"] },
  { macro: "Marketing Performance", core: "Executive Approved", tags: ["Executive Approved"] },
  { macro: "Project Reference", core: "Project Status", tags: ["Project Status"] },
  { macro: "Project Reference", core: "Lead Studio", tags: ["Lead Studio"] },
  { macro: "Project Reference", core: "Scope of Work", tags: ["Scope of Work"] },
  { macro: "Video & Motion", core: "Motion Format", tags: ["Motion Format"] },
  { macro: "Video & Motion", core: "Master / Derivative", tags: ["Master / Derivative"] },
  { macro: "Video & Motion", core: "Audio & Language", tags: ["Audio & Language"] },
  { macro: "Video & Motion", core: "Drone Compliance", tags: ["Drone Compliance"] },
  { macro: "Rights & Licensing", core: "Licence Type", tags: ["Licence Type"] },
  { macro: "Rights & Licensing", core: "Confidentiality Status", tags: ["Confidentiality Status"] },
  { macro: "Rights & Licensing", core: "Consent / Releases", tags: ["Consent / Releases"] },
  { macro: "Rights & Licensing", core: "Territory Restrictions", tags: ["Territory Restrictions"] },
  { macro: "Asset Lifecycle", core: "Status", tags: ["Draft", "In Review", "Approved", "Published", "Superseded", "Expired", "Archived"] },
  { macro: "Asset Lifecycle", core: "Version Numbering", tags: ["Version Numbering"] },
  { macro: "Asset Lifecycle", core: "Review Cadence", tags: ["Review Cadence"] },
  { macro: "AI Provenance", core: "Digital Source Type", tags: ["Digital Source Type"] },
  { macro: "AI Provenance", core: "AI System Used", tags: ["AI System Used"] },
  { macro: "AI Provenance", core: "Prompt on File", tags: ["Prompt on File"] },
  { macro: "AI Provenance", core: "Content Credentials", tags: ["Content Credentials"] },
  { macro: "AI Provenance", core: "Disclosure Clearance", tags: ["Disclosure Clearance"] },
];

// --- Sanitising -------------------------------------------------------------

const clip = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

// Accepts anything (a tampered client must never throw) and returns a clean,
// bounded row set. Rows missing a macro or core are dropped.
export function sanitizeTaxonomyRows(input: unknown): TaxonomyRow[] {
  const arr = Array.isArray(input) ? input : [];
  const out: TaxonomyRow[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const macro = clip(r.macro, 80);
    const core = clip(r.core, 80);
    if (!macro || !core) continue;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of Array.isArray(r.tags) ? r.tags : []) {
      const tag = clip(t, 80);
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      tags.push(tag);
      if (tags.length >= 60) break;
    }
    out.push({ macro, core, tags });
    if (out.length >= 300) break;
  }
  return out;
}

// --- Persistence ------------------------------------------------------------

let cache: { rows: TaxonomyRow[]; at: number } | null = null;
const TTL_MS = 60 * 1000;

export function clearTaxonomyCache() {
  cache = null;
}

// Escape every non-ASCII char so the JSON document survives being chunked at
// arbitrary offsets (a chunk boundary through a raw multi-byte char would
// produce invalid text rows).
function toAsciiJson(value: unknown): string {
  const json = JSON.stringify(value);
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out +=
      code > 0x7e
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : json[i];
  }
  return out;
}

export async function getTaxonomyRows(): Promise<TaxonomyRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;

  try {
    const { data, error } = await supabaseAdmin
      .from("common_dam_presets")
      .select("tag, sort_order")
      .eq("group_name", TAXONOMY_GROUP)
      .order("sort_order", { ascending: true });
    if (error) throw error;

    if (data && data.length) {
      const json = data.map((r) => r.tag).join("");
      const parsed = JSON.parse(json) as { v?: number; rows?: unknown };
      const rows = sanitizeTaxonomyRows(parsed?.rows);
      if (rows.length) {
        cache = { rows, at: Date.now() };
        return rows;
      }
    }
  } catch (e) {
    // A partially-written document or transient DB error must never take the
    // taxonomy down — fall through to the built-in defaults.
    console.error("Taxonomy fetch failed; using defaults:", e);
  }

  cache = { rows: DEFAULT_TAXONOMY_ROWS, at: Date.now() };
  return DEFAULT_TAXONOMY_ROWS;
}

export async function saveTaxonomyRows(
  input: unknown
): Promise<TaxonomyRow[]> {
  const rows = sanitizeTaxonomyRows(input);
  if (!rows.length) {
    throw new Error("The taxonomy needs at least one row.");
  }

  const json = toAsciiJson({ v: 1, rows });
  const chunks: { group_name: string; tag: string; sort_order: number }[] = [];
  for (let i = 0; i * CHUNK_SIZE < json.length; i++) {
    chunks.push({
      group_name: TAXONOMY_GROUP,
      tag: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      sort_order: i,
    });
  }

  // Not atomic (PostgREST has no transactions) — a read landing between the
  // delete and the insert parses nothing and serves defaults for one cache
  // TTL. Acceptable for a settings save.
  const del = await supabaseAdmin
    .from("common_dam_presets")
    .delete()
    .eq("group_name", TAXONOMY_GROUP);
  if (del.error) throw new Error(del.error.message);

  const ins = await supabaseAdmin.from("common_dam_presets").insert(chunks);
  if (ins.error) throw new Error(ins.error.message);

  cache = { rows, at: Date.now() };
  return rows;
}

export async function resetTaxonomy(): Promise<TaxonomyRow[]> {
  const del = await supabaseAdmin
    .from("common_dam_presets")
    .delete()
    .eq("group_name", TAXONOMY_GROUP);
  if (del.error) throw new Error(del.error.message);

  cache = { rows: DEFAULT_TAXONOMY_ROWS, at: Date.now() };
  return DEFAULT_TAXONOMY_ROWS;
}

// --- Derived shapes ----------------------------------------------------------

export async function getTaxonomyTree(): Promise<MacroPortfolio[]> {
  return rowsToTree(await getTaxonomyRows());
}
