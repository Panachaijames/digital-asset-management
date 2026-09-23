// tools/pgtest/test.mjs — the v2 database's behaviour suite.
//
// WHAT IT RUNS
//   SCHEMA.sql, then every file in supabase/migrations (harness migrationFiles()), then fixtures.sql,
//   in PGlite, once per privilege regime: "legacy" (the default grants the v2 project was created
//   under) and "revoked" (a new Supabase project, or plain Postgres). Each regime builds ONE
//   database. Every check that writes runs inside a transaction that is rolled back, so no check
//   sees another's changes. The one committed write is the search-row drain in section 6, which is
//   idempotent (it finds nothing to do on a database the fixture loaded through the triggers).
//
// WHAT IT PROVES (the numbers are the sections below)
//   1  The chain applies, and the fixture library loads through every trigger the migrations attach.
//   2  Privileges: authenticated reads tables through RLS (and an inactive user reads nothing, m2's
//      null-role fix), anon reaches no table and no helper, and no function a migration creates is
//      executable by anon or PUBLIC.
//   3  Settings: the seeded keys (SPEC 2B.53 via FACTS integrity.md 2.1, as amended by contract
//      section 2), the accessor's P0002, the bigint wrapper, and the three guard triggers.
//   4  The five system principals, and dam_is_system() being true only for a system claim naming one.
//   5  dam_provision_user: the gate, the creation rules, idempotence, never touching an existing row's
//      role, activation or cross-studio flag, and the users guard trigger admitting its bookkeeping.
//   6  The search row: the drain backfills it; every row equals what its base rows say (recomputed
//      here in JavaScript, independently of the rebuild SQL) and what m2's live helpers say; the
//      reindex triggers keep it fresh; category and keyword renames mark rows stale and the drain
//      fixes them; the writers are service_role only; the cron job is scheduled.
//   7  Taxonomy integrity: link targets and namespaces, exclusive categories, keyword path and
//      descendant_ids maintenance, cycles, max_depth, soft deletes, external-id immutability.
//   8  The search RPCs: visibility per principal, every filter, keyset paging through the fixture's
//      created_at tie group, count, facets, hydration, input validation and privileges.
//   Expected values come from the fixture rows (see the header of fixtures.sql) and the contract.
//   None is a snapshot of what the SQL under test returned.
//
// WHAT IT CANNOT PROVE
//   * Concurrency. PGlite is one connection in one process. Advisory locks, two first sign-ins racing
//     in dam_provision_user, two drains, lock order and deadlocks are never exercised.
//   * Version drift. PGlite is Postgres 18; v2 runs 17.6. PGlite's collation is C, so every text
//     ORDER BY (keyword names, facet values, descendant_ids by path) is checked in C order only.
//   * pg_cron. cron.schedule() is a stub that records the job; nothing runs on a timer, so the drain
//     is called by hand here, as the cron job would call it.
//   * PostgREST and the JWT. asPrincipal() sets the role and request.jwt.claims; signature checks,
//     max_rows and HTTP status mapping belong to the web tier's tests.
//   * Scale and plans. 26 assets: the 50,000-row count cap, index use and timings are not measured.
//   * The imported data. The fixture has the import's shapes, not its 34,949 rows.
//
// RUN
//   cd tools/pgtest && node test.mjs          (Git Bash: timeout 600 node test.mjs < /dev/null)
//   One line per check (PASS or FAIL), a summary per regime and a total. Exit code 1 on any failure.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asPrincipal, createDb, migrationFiles, systemClaims, userClaims, WEB_SYSTEM_USER_ID } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures.sql");

// =================================================================================================
// Reporting
// =================================================================================================
let regime = "";
let counts = { pass: 0, fail: 0 };
const totals = { pass: 0, fail: 0 };
const failures = [];

function check(name, cond, detail = "") {
  const label = `[${regime}] ${name}`;
  if (cond) {
    counts.pass++;
    console.log(`PASS ${label}`);
  } else {
    counts.fail++;
    failures.push(label);
    console.log(`FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
  return Boolean(cond);
}
const show = (x) => JSON.stringify(x);
const eq = (name, got, want) => check(name, show(got) === show(want), `got  ${show(got)}\n       want ${show(want)}`);
const byValue = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0);
function sameSet(name, got, want) {
  const g = [...got].sort(byValue);
  const w = [...new Set(want)].sort(byValue);
  const dupes = got.length !== new Set(got).size;
  return check(name, !dupes && show(g) === show(w), `${dupes ? "(duplicates) " : ""}got  ${show(g)}\n       want ${show(w)}`);
}
// Top-level keys sorted, so a jsonb object compares regardless of its key order.
const canon = (o) => (o && typeof o === "object" && !Array.isArray(o) ? JSON.stringify(o, Object.keys(o).sort()) : JSON.stringify(o));
const codeOf = (e) => e?.code ?? e?.cause?.code;

// fn must fail with this SQLSTATE (and, when given, a message matching pattern).
async function expectError(name, fn, sqlstate, pattern) {
  try {
    await fn();
  } catch (e) {
    return check(`${name} -> ${sqlstate}`, codeOf(e) === sqlstate && (!pattern || pattern.test(e.message)), `got ${codeOf(e)}: ${e.message}`);
  }
  return check(`${name} -> ${sqlstate}`, false, "no error was raised");
}
// fn must not raise (and must not return false).
async function expectOk(name, fn) {
  try {
    const r = await fn();
    return check(name, r !== false, "returned false");
  } catch (e) {
    return check(name, false, `${codeOf(e)}: ${e.message}`);
  }
}
// A section that crashes records one FAIL and lets the next section run.
async function section(title, fn) {
  console.log(`\n-- ${title}`);
  try {
    await fn();
  } catch (e) {
    check(`${title}: the section ran to its end`, false, `${codeOf(e) ?? ""} ${e.stack ?? e}`);
  }
}

// =================================================================================================
// Database helpers
// =================================================================================================
const ROLLBACK = Symbol("rollback");
// Runs fn(tx) as the database owner (no claims, like a migration) and always rolls back.
async function inTx(db, fn) {
  let out;
  try {
    await db.transaction(async (tx) => {
      out = await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}
// Inside inTx: switch to a PostgREST principal, exactly as asPrincipal() does.
async function become(tx, claims) {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
  const role = claims?.role === "service_role" ? "service_role" : claims?.role === "anon" ? "anon" : "authenticated";
  await tx.exec(`set local role ${role}`);
}
// Inside inTx: back to the owner with no claims.
async function becomeOwner(tx) {
  await tx.exec(`reset role`);
  await tx.query(`select set_config('request.jwt.claims', '', true)`);
}
const rows = async (q, sql, params) => (await q.query(sql, params)).rows;
const one = async (q, sql, params) => (await q.query(sql, params)).rows[0];
const val = async (q, sql, params) => {
  const r = await one(q, sql, params);
  return r === undefined ? undefined : Object.values(r)[0];
};
const pgArray = (xs) => `{${xs.join(",")}}`;
const SERVICE = { role: "service_role" };
const ANON = { role: "anon" };

// =================================================================================================
// Fixture facts (tools/pgtest/fixtures.sql and the SCHEMA.sql seeds)
// =================================================================================================
const fid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = (n) => fid("fa000000", n); // assets 01-26
const P = (n) => fid("f1000000", n); // projects 01-06
const U = (n) => fid("f9000000", n); // test principals 01-07
const PK = (n) => fid("f7000000", n); // project (Sector) keywords
const AK = (n) => fid("f6000000", n); // asset keywords
const LINK = (n) => fid("fd000000", n); // keyword links
const EXT = (n) => fid("fe000000", n); // external ids
const V1 = (n) => fid("0e1f0000", n); // the v1 id each asset carries
const num = (uuid) => Number(uuid.slice(24)); // asset uuid -> its fixture number
const pad2 = (n) => String(n).padStart(2, "0");
const objectKey = (n) => `1Fx${pad2(n)}DamFixtureFile00000000000000`;
const driveUrl = (n) => `https://drive.google.com/file/d/${objectKey(n)}/view?usp=drivesdk`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const minus = (xs, ys) => xs.filter((x) => !ys.includes(x));

const ST = {
  australia: "51000000-0000-4000-8000-000000000001", // region group
  bangkok: "51000000-0000-4000-8000-000000000003",
  london: "51000000-0000-4000-8000-000000000008",
  malaysia: "51000000-0000-4000-8000-000000000009",
  singapore: "51000000-0000-4000-8000-00000000000e",
  sydney: "51000000-0000-4000-8000-000000000011", // child of australia
};
const LV = {
  firm: "a1000000-0000-4000-8000-000000000001",
  studio: "a1000000-0000-4000-8000-000000000002",
  restricted: "a1000000-0000-4000-8000-000000000003", // grant_only, min_role editor
};
const CAT = {
  photo: "c1000000-0000-4000-8000-000000000001", // Studio level
  renderings: "c1000000-0000-4000-8000-000000000002", // Studio level
  logos: "c1000000-0000-4000-8000-000000000005", // Firm-wide
  collateral: "c1000000-0000-4000-8000-000000000006", // Firm-wide
};
const KC = {
  spaceType: "41000000-0000-4000-8000-000000000001", // max_depth 3
  timeOfDay: "41000000-0000-4000-8000-000000000003", // exclusive, max_depth 1
  sector: "41000000-0000-4000-8000-000000000011", // project namespace, max_depth 3
  designStyle: "f4000000-0000-4000-8000-000000000003",
};

const ALL = range(1, 26);
const BKK = [...range(1, 10), 18, 19, 20]; // projects 01, 02, 05 (home Bangkok)
const SGP = range(11, 14); // project 03 (home Singapore; 13 and 14 carry studio_id Malaysia, ignored)
const AUS = [15, 16, 17, 23]; // project 04 (home: the australia region group) and project-less 23
const NO_STUDIO = [21, 22, 25]; // Studio level, empty studio set (project 06 has no studio; 25 has neither)
const FIRM = [24, 26]; // Firm-wide by category, no project
const OPEN = [...NO_STUDIO, ...FIRM]; // what every active viewer sees without a studio in common
const PENDING = 3;
const RESTRICTED = 10; // explicit Restricted (grant_only, editor floor)
const PHOTO = minus(ALL, [4, 5, 21, 24, 26]); // category Project Photography
const projectOf = (n) => (n <= 5 ? 1 : n <= 10 ? 2 : n <= 14 ? 3 : n <= 17 ? 4 : n <= 20 ? 5 : n <= 22 ? 6 : null);
const studiosOf = (n) => (BKK.includes(n) ? [ST.bangkok] : SGP.includes(n) ? [ST.singapore] : AUS.includes(n) ? [ST.australia] : []);
const levelOf = (n) => (n === RESTRICTED ? LV.restricted : FIRM.includes(n) ? LV.firm : LV.studio);

// Every asset in the default order (created_at desc, asset_id desc), read off the fixture's
// created_at values. 11, 12, 13 and 15 share 2025-03-14T09:12:44.123Z.
const ORDER_DESC = [24, 22, 21, 20, 19, 18, 10, 9, 8, 7, 6, 16, 14, 15, 13, 12, 11, 25, 5, 4, 3, 2, 1, 23, 26, 17];
const TIE_AT = "2025-03-14T09:12:44.123Z";

// SPEC 2B.53's seed (FACTS integrity.md 2.1) minus ai.autoaccept_confidence, plus
// users.default_cross_studio_visibility (contract section 2): key -> [value_type, value].
const SEEDED_SETTINGS = {
  "firm.legal_name": ["string", "dwp"],
  "firm.timezone": ["string", "Asia/Bangkok"],
  "users.auto_activate_domains": ["array", ["dwp.com"]],
  "users.default_cross_studio_visibility": ["boolean", true],
  "albums.max_depth": ["integer", 5],
  "text_blocks.allow_self_approval": ["boolean", false],
  "templates.allow_self_approval": ["boolean", false],
  "review.allow_self_approval": ["boolean", false],
  "rights.expiring_days": ["integer", 30],
  "watermark.default_text": ["string", "dwp — for review"],
  "shares.default_ttl_days": ["integer", 30],
  "upload_requests.default_ttl_days": ["integer", 14],
  "uploads.max_file_bytes": ["integer", 10737418240],
  "jobs.visibility_timeout_seconds": ["integer", 900],
  "integrations.max_consecutive_failures": ["integer", 5],
  "webhooks.rotation_overlap_hours": ["integer", 24],
  "audit.redacted_columns": ["array", ["key_hash", "token_hash", "password_hash", "secret_hash", "api_secret", "private_key"]],
  "privacy.ip_hash_salt_secret_name": ["string", "DAM_IP_HASH_SALT"],
  "notifications.digest_hour": ["integer", 8],
  "ai.runs_retention_months": ["integer", 24],
  "search.default_limit": ["integer", 50],
  "search.max_limit": ["integer", 200],
};

const SYSTEM_PRINCIPALS = [
  ["00000000-0000-0000-0000-000000000001", "migration@system.dam.invalid", "Migration"],
  ["00000000-0000-0000-0000-000000000002", "worker@system.dam.invalid", "Worker"],
  ["00000000-0000-0000-0000-000000000003", "sync@system.dam.invalid", "Directory sync"],
  ["00000000-0000-0000-0000-000000000004", "ai@system.dam.invalid", "AI"],
  ["00000000-0000-0000-0000-000000000005", "web@system.dam.invalid", "Web service"],
];

const EXPECTED_MIGRATIONS = [
  "20260923120000_p1_grants_settings_principals.sql",
  "20260923120100_p1_identity_helpers.sql",
  "20260923120200_p1_search_row.sql",
  "20260923120300_p1_taxonomy_integrity.sql",
  "20260923120400_p1_search_rpcs.sql",
];

// The claims of each fixture principal (the email is informational: helpers read the tables).
const as = (n) => userClaims(U(n), `fixture.${n}@dwp.com`);

// =================================================================================================
// The search row, recomputed from the base tables in JavaScript (contract section 4)
// =================================================================================================
const SCOPE_RANK = { firm: 1, studio: 2, grant_only: 3 };
const ROLE_RANK = { viewer: 1, contributor: 2, editor: 3, studio_admin: 4, global_admin: 5, owner: 6 };

async function expectedSearchRows(q) {
  const assets = await rows(q, `select id, studio_id, access_level_id, category_id from dam_assets`);
  const projects = new Map((await rows(q, `select id, studio_id, access_level_id, deleted_at from dam_projects`)).map((r) => [r.id, r]));
  const contributing = await rows(q, `select project_id, studio_id from dam_project_studios where deleted_at is null`);
  const projectLinks = await rows(q, `select asset_id, project_id from dam_project_assets where deleted_at is null`);
  const levels = new Map((await rows(q, `select id, scope::text as scope, min_role::text as min_role from dam_access_levels`)).map((r) => [r.id, r]));
  const categoryLevel = new Map((await rows(q, `select id, access_level_id from dam_categories`)).map((r) => [r.id, r.access_level_id]));
  const keywords = new Map((await rows(q, `select id, parent_id, namespace::text as ns, deleted_at from dam_keywords`)).map((r) => [r.id, r]));
  const keywordLinks = await rows(q, `select keyword_id, target_type::text as tt, target_id from dam_keyword_links where deleted_at is null`);

  const sorted = (xs) => [...new Set(xs)].sort();
  // A live keyword of the namespace and every live ancestor of it, walked on parent_id.
  const withAncestors = (ids, ns) => {
    const out = new Set();
    for (const id of ids) {
      for (let k = keywords.get(id); k && !k.deleted_at && k.ns === ns; k = k.parent_id ? keywords.get(k.parent_id) : undefined) out.add(k.id);
    }
    return [...out].sort();
  };
  const expected = new Map();
  for (const a of assets) {
    const projectIds = sorted(projectLinks.filter((l) => l.asset_id === a.id && projects.get(l.project_id)?.deleted_at === null).map((l) => l.project_id));
    const projectStudios = sorted(projectIds.flatMap((p) => [projects.get(p).studio_id, ...contributing.filter((c) => c.project_id === p).map((c) => c.studio_id)]).filter(Boolean));
    const mostRestrictive = projectIds
      .map((p) => levels.get(projects.get(p).access_level_id))
      .sort((x, y) => SCOPE_RANK[y.scope] - SCOPE_RANK[x.scope] || ROLE_RANK[y.min_role] - ROLE_RANK[x.min_role] || byValue(x.id, y.id))[0];
    expected.set(a.id, {
      studio_ids: projectStudios.length ? projectStudios : a.studio_id ? [a.studio_id] : [],
      access_level_id: a.access_level_id ?? mostRestrictive?.id ?? categoryLevel.get(a.category_id),
      project_ids: projectIds,
      asset_keyword_ids: withAncestors(keywordLinks.filter((l) => l.tt === "asset" && l.target_id === a.id).map((l) => l.keyword_id), "asset"),
      project_keyword_ids: withAncestors(keywordLinks.filter((l) => l.tt === "project" && projectIds.includes(l.target_id)).map((l) => l.keyword_id), "project"),
    });
  }
  return expected;
}

// Every way a search row can disagree with its sources; [] when all 26 are right.
async function searchRowMismatches(q) {
  const want = await expectedSearchRows(q);
  const got = await rows(q, `select asset_id, studio_ids, access_level_id, project_ids, asset_keyword_ids, project_keyword_ids from dam_asset_search`);
  const bad = [];
  if (got.length !== want.size) bad.push(`${got.length} search rows for ${want.size} assets`);
  for (const r of got) {
    const w = want.get(r.asset_id);
    if (!w) {
      bad.push(`search row ${r.asset_id} has no asset`);
      continue;
    }
    const cmp = (col, g, x) => show(g) !== show(x) && bad.push(`asset ${num(r.asset_id)} ${col}: got ${show(g)} want ${show(x)}`);
    cmp("studio_ids", r.studio_ids, w.studio_ids); // sorted and distinct by contract (m2's convention)
    cmp("access_level_id", r.access_level_id, w.access_level_id);
    cmp("project_ids", [...r.project_ids].sort(), w.project_ids);
    cmp("asset_keyword_ids", [...r.asset_keyword_ids].sort(), w.asset_keyword_ids);
    cmp("project_keyword_ids", [...r.project_keyword_ids].sort(), w.project_keyword_ids);
  }
  const copied = await rows(q, `
    select s.asset_id from dam_asset_search s join dam_assets a on a.id = s.asset_id
     where (s.filename, s.title, s.status, s.category_id, s.file_kind, s.mime_type, s.size_bytes, s.created_at, s.deleted_at, s.ingest_relative_path)
           is distinct from
           (a.filename, a.title, a.status, a.category_id, a.file_kind, a.mime_type, a.size_bytes, a.created_at, a.deleted_at, a.ingest_relative_path)`);
  for (const r of copied) bad.push(`asset ${num(r.asset_id)}: a column copied from dam_assets differs`);
  const helpers = await rows(q, `
    select asset_id from dam_asset_search
     where studio_ids is distinct from dam_asset_studio_ids(asset_id)
        or access_level_id is distinct from dam_asset_effective_level(asset_id)`);
  for (const r of helpers) bad.push(`asset ${num(r.asset_id)}: disagrees with dam_asset_studio_ids/dam_asset_effective_level`);
  for (const r of await staleRows(q)) bad.push(`asset ${r} is stale`);
  return bad;
}
const staleRows = async (q) => (await rows(q, `select asset_id from dam_asset_search where indexed_at < updated_at order by 1`)).map((r) => num(r.asset_id));
const freshCheck = async (name, q) => {
  const bad = await searchRowMismatches(q);
  return check(name, bad.length === 0, bad.slice(0, 6).join("\n       "));
};

// =================================================================================================
// Search RPC helpers
// =================================================================================================
const search = (tx, p) => rows(tx, `select * from dam_search_assets($1::jsonb)`, [p === null ? null : JSON.stringify(p ?? {})]);
const countOf = (tx, p) => one(tx, `select total::int as total, is_estimate from dam_search_assets_count($1::jsonb)`, [JSON.stringify(p ?? {})]);
const facetsOf = (tx, p) => rows(tx, `select facet, value, count::int as count from dam_search_facets($1::jsonb)`, [JSON.stringify(p ?? {})]);

// The visible asset numbers (one unpaged page) and the count RPC's total for the same p.
async function visibleIn(tx, p = {}) {
  const r = await search(tx, { limit: 200, ...p });
  const c = await countOf(tx, p);
  return { nums: r.map((x) => num(x.asset_id)), rows: r, total: c.total, estimate: c.is_estimate };
}
const visibleAs = (db, claims, p) => asPrincipal(db, claims, (tx) => visibleIn(tx, p));
// setup(tx) runs as the owner, then the search runs as claims, in one rolled-back transaction.
const visibleAfter = (db, setup, claims, p) => inTx(db, async (tx) => {
  await setup(tx);
  await become(tx, claims);
  return visibleIn(tx, p);
});
function checkVisible(name, v, want) {
  sameSet(name, v.nums, want);
  check(`${name}: count agrees (${want.length}, exact)`, v.total === v.nums.length && v.total === want.length && v.estimate === false, `count ${v.total} estimate ${v.estimate}, rows ${v.nums.length}`);
}

const ARRAY_FACETS = new Set(["studio_ids", "asset_keyword_ids", "project_keyword_ids", "project_ids"]);
// What dam_search_facets must return for these rows: top 50 per facet, count desc, then value (C order).
function facetsFromRows(rs, facets) {
  const out = [];
  for (const f of facets) {
    const n = new Map();
    for (const r of rs) for (const v of ARRAY_FACETS.has(f) ? r[f] : [r[f]]) if (v !== null && v !== undefined) n.set(String(v), (n.get(String(v)) ?? 0) + 1);
    for (const [value, count] of [...n].sort((a, b) => b[1] - a[1] || byValue(a[0], b[0])).slice(0, 50)) out.push({ facet: f, value, count });
  }
  return out;
}
const facetPairs = (fs, facet) => fs.filter((r) => r.facet === facet).map((r) => [r.value, r.count]);

// Walk every page with the keyset cursor; returns the asset ids in the order served.
async function walkPages(db, claims, sort, size) {
  return asPrincipal(db, claims, async (tx) => {
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 200; i++) {
      const page = await search(tx, { sort, limit: size, ...(cursor ? { cursor } : {}) });
      if (!page.length) break;
      seen.push(...page.map((r) => r.asset_id));
      const last = page[page.length - 1];
      cursor = { created_at: last.created_at.toISOString(), asset_id: last.asset_id };
    }
    return seen;
  });
}

// =================================================================================================
// 1. The chain applies with the fixtures
// =================================================================================================
async function chainChecks(db) {
  eq("the migration chain is the five phase 1 files, in order", migrationFiles().map((f) => basename(f)), EXPECTED_MIGRATIONS);
  const c = await one(db, `select (select count(*) from dam_assets)::int as assets, (select count(*) from dam_projects)::int as projects,
    (select count(*) from dam_keywords)::int as keywords, (select count(*) from dam_keyword_links)::int as links,
    (select count(*) from dam_users)::int as users, (select count(*) from dam_asset_search)::int as search_rows`);
  eq("fixture row counts (26 assets, 6 projects, 48 keywords, 135 links, 5 system + 7 test users)", c,
    { assets: 26, projects: 6, keywords: 48, links: 135, users: 12, search_rows: 26 });
  eq("the fixture loaded through the reindex triggers: no search row is stale", await staleRows(db), []);
}

// =================================================================================================
// 2. Grants
// =================================================================================================
async function grantChecks(db) {
  eq("authenticated (Bangkok viewer) reads dam_studios through RLS: all 20 studios",
    await asPrincipal(db, as(1), (tx) => val(tx, `select count(*)::int from dam_studios`)), 20);
  await expectOk("authenticated can query assets, projects, keywords and the search table without a privilege error", () =>
    asPrincipal(db, as(1), async (tx) => {
      for (const t of ["dam_assets", "dam_projects", "dam_keywords", "dam_keyword_links", "dam_asset_search", "dam_settings", "dam_users"]) await tx.query(`select count(*) from ${t}`);
    }));
  for (const t of ["dam_studios", "dam_assets", "dam_asset_search", "dam_settings", "dam_users"]) {
    await expectError(`anon cannot read ${t}`, () => asPrincipal(db, ANON, (tx) => tx.query(`select 1 from ${t} limit 1`)), "42501");
  }
  for (const [label, sql] of [
    ["dam_setting", `select dam_setting('search.max_limit')`],
    ["dam_is_system", `select dam_is_system()`],
    ["dam_current_role_in_studios", `select dam_current_role_in_studios('{}')`],
    ["dam_asset_studio_ids", `select dam_asset_studio_ids('${A(1)}')`],
    ["dam_provision_user", `select * from dam_provision_user('someone@dwp.com')`],
    ["dam_search_assets", `select * from dam_search_assets('{}')`],
  ]) {
    await expectError(`anon cannot execute ${label}`, () => asPrincipal(db, ANON, (tx) => tx.query(sql)), "42501", /permission denied/);
  }

  // m2's null-role fix in dam_access_level_allows, which the base-table read policies call.
  const assetsReadBy = (claims) => asPrincipal(db, claims, (tx) => val(tx, `select count(*)::int from dam_assets`));
  eq("RLS: an inactive user (06) reads no dam_assets row (the null-role fix)", await assetsReadBy(as(6)), 0);
  eq("RLS: an unprovisioned sub reads no dam_assets row", await assetsReadBy(userClaims("99999999-9999-4999-8999-999999999999")), 0);
  check("RLS: an active viewer (01) does read assets", (await assetsReadBy(as(1))) > 0);
  eq("dam_access_level_allows(Firm-wide, no owning studio): false for the inactive user, true for an active viewer",
    [await asPrincipal(db, as(6), (tx) => val(tx, `select dam_access_level_allows($1, null)`, [LV.firm])),
      await asPrincipal(db, as(1), (tx) => val(tx, `select dam_access_level_allows($1, null)`, [LV.firm]))], [false, true]);

  const tables = await rows(db, `
    select c.relname,
           has_table_privilege('authenticated', c.oid, 'SELECT') and has_table_privilege('authenticated', c.oid, 'INSERT')
             and has_table_privilege('authenticated', c.oid, 'UPDATE') and has_table_privilege('authenticated', c.oid, 'DELETE') as auth_dml,
           has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT')
             and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE')
             and has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_all,
           has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_any,
           exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee = 0) as public_any
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname like 'dam\\_%'`);
  check(`every dam_ table (${tables.length}, partitions included): authenticated has S/I/U/D, service_role all, anon and PUBLIC nothing`,
    tables.length > 90 && tables.every((t) => t.auth_dml && t.service_all && !t.anon_any && !t.public_any),
    tables.filter((t) => !(t.auth_dml && t.service_all && !t.anon_any && !t.public_any)).map((t) => t.relname).slice(0, 10).join(", "));

  // Every function a migration creates or replaces, read off the files themselves.
  const names = new Set();
  for (const f of migrationFiles()) {
    for (const m of readFileSync(f, "utf8").matchAll(/create\s+or\s+replace\s+function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) names.add(m[1].toLowerCase());
  }
  const fns = await rows(db, `
    select p.proname, p.oid::regprocedure::text as sig, p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), '') as config,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                    where x.grantee = 0 and x.privilege_type = 'EXECUTE') as public_exec
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])`, [pgArray([...names])]);
  const found = new Set(fns.map((f) => f.proname));
  check(`all ${names.size} functions named in the migration files exist`, names.size >= 40 && [...names].every((n) => found.has(n)), [...names].filter((n) => !found.has(n)).join(", "));
  check("no migration function is executable by anon or PUBLIC", fns.every((f) => !f.anon && !f.public_exec),
    fns.filter((f) => f.anon || f.public_exec).map((f) => f.sig).join(", "));
  check("every SECURITY DEFINER migration function pins its search_path", fns.every((f) => !f.prosecdef || /search_path=/.test(f.config)),
    fns.filter((f) => f.prosecdef && !/search_path=/.test(f.config)).map((f) => f.sig).join(", "));
  const serviceOnly = ["dam_rebuild_asset_search_batch(uuid[])", "dam_rebuild_asset_search(uuid)", "dam_mark_search_stale(uuid[])",
    "dam_reindex_stale(integer)", "dam_search_sql_where(jsonb)", "dam_keyword_descendant_ids(uuid)"];
  const acl = await rows(db, `select f, has_function_privilege('authenticated', f, 'EXECUTE') as auth, has_function_privilege('service_role', f, 'EXECUTE') as svc
    from unnest($1::text[]) as f`, [pgArray(serviceOnly)]);
  check("service_role-only functions: authenticated refused, service_role allowed", acl.every((r) => !r.auth && r.svc), show(acl.filter((r) => r.auth || !r.svc)));
}

// =================================================================================================
// 3. Settings
// =================================================================================================
async function settingsChecks(db) {
  const seeded = await rows(db, `select key, value_type, value, default_value, is_system, group_name from dam_settings where deleted_at is null order by key`);
  sameSet("exactly the 22 seeded keys are live", seeded.map((r) => r.key), Object.keys(SEEDED_SETTINGS));
  const wrong = seeded.filter((r) => {
    const w = SEEDED_SETTINGS[r.key];
    return !w || r.value_type !== w[0] || show(r.value) !== show(w[1]) || show(r.default_value) !== show(r.value) || r.is_system !== true;
  });
  check("each seeded key has its SPEC type and value, value = default_value, and is a system key", wrong.length === 0, show(wrong.map((r) => r.key)));
  check("ai.autoaccept_confidence is not seeded (contract deviation 2)", !seeded.some((r) => r.key === "ai.autoaccept_confidence"));
  eq("groups the settings page reads: users.* privacy, search.* search, uploads.max_file_bytes uploads",
    seeded.filter((r) => /^(users|search)\.|^uploads\./.test(r.key)).map((r) => `${r.key}:${r.group_name}`),
    ["search.default_limit:search", "search.max_limit:search", "uploads.max_file_bytes:uploads", "users.auto_activate_domains:privacy", "users.default_cross_studio_visibility:privacy"]);

  await expectError("dam_setting of an unknown key", () => db.query(`select dam_setting('no.such_key')`), "P0002", /dam_unknown_setting: no\.such_key/);
  await expectError("dam_setting_int of an unknown key", () => db.query(`select dam_setting_int('no.such_key')`), "P0002", /dam_unknown_setting/);
  eq("dam_setting_int('uploads.max_file_bytes') is the bigint 10737418240",
    await one(db, `select dam_setting_int('uploads.max_file_bytes')::text as v, pg_typeof(dam_setting_int('uploads.max_file_bytes'))::text as t`),
    { v: "10737418240", t: "bigint" });
  eq("typed wrappers: text unquoted, int, bool",
    await one(db, `select dam_setting_text('firm.timezone') as tz, dam_setting_int('search.default_limit')::int as dl,
                          dam_setting_bool('users.default_cross_studio_visibility') as cross`),
    { tz: "Asia/Bangkok", dl: 50, cross: true });
  eq("a signed-in user can read a setting (authenticated grant)", await asPrincipal(db, as(1), (tx) => val(tx, `select dam_setting_int('search.max_limit')::int`)), 200);

  await expectError("deleting a system key", () => inTx(db, (tx) => tx.query(`delete from dam_settings where key = 'search.max_limit'`)), "42501", /dam_setting_protected/);
  await expectError("soft-deleting a system key", () => inTx(db, (tx) => tx.query(`update dam_settings set deleted_at = now() where key = 'search.max_limit'`)), "42501", /dam_setting_protected/);
  await expectError("a secret-shaped value", () => inTx(db, (tx) => tx.query(`update dam_settings set value = '"sk-abcdefghijklmnopqrstuvwxyz0123"' where key = 'firm.legal_name'`)), "23514", /dam_setting_secret/);
  await expectError("a new key named like a secret", () => inTx(db, (tx) => tx.query(`insert into dam_settings (key, value, value_type, default_value, description, is_system)
      values ('integrations.hubspot_api_key', '"x"', 'string', '"x"', 'Probe.', false)`)), "23514", /dam_setting_secret/);
  await expectError("search.max_limit = 0 (below its min of 1)", () => inTx(db, (tx) => tx.query(`update dam_settings set value = '0' where key = 'search.max_limit'`)), "23514", /dam_setting_invalid/);
  await expectError("search.max_limit = 1001 (above its max of 1000)", () => inTx(db, (tx) => tx.query(`update dam_settings set value = '1001' where key = 'search.max_limit'`)), "23514", /dam_setting_invalid/);
  await expectError("notifications.digest_hour = 24", () => inTx(db, (tx) => tx.query(`update dam_settings set value = '24' where key = 'notifications.digest_hour'`)), "23514", /dam_setting_invalid/);
  eq("an in-range value is accepted and read back in the same transaction",
    await inTx(db, async (tx) => {
      await tx.query(`update dam_settings set value = '100' where key = 'search.max_limit'`);
      return val(tx, `select dam_setting_int('search.max_limit')::int`);
    }), 100);
}

// =================================================================================================
// 4. System principals
// =================================================================================================
async function systemPrincipalChecks(db) {
  const r = await rows(db, `select id, email, display_name, role::text as role, is_active, is_system, deleted_at from dam_users where is_system order by id`);
  eq("the five system principals, with fixed ids, reserved emails and names", r.map((x) => [x.id, x.email, x.display_name]), SYSTEM_PRINCIPALS);
  check("system principals are global_admin rows that are inactive and live (inert by the CHECK)",
    r.length === 5 && r.every((x) => x.role === "global_admin" && x.is_active === false && x.deleted_at === null));
  for (const [id, email] of SYSTEM_PRINCIPALS) {
    eq(`dam_is_system() is true for a system token naming ${email}`, await asPrincipal(db, systemClaims(id), (tx) => val(tx, `select dam_is_system()`)), true);
  }
  const notSystem = [
    ["a user token for a person", as(1)],
    ["a user token for the global admin person", as(5)],
    ["a system claim naming a person", systemClaims(U(5))],
    ["a system claim naming an unknown id", systemClaims("99999999-9999-4999-8999-999999999999")],
    ["a user claim naming the web principal", userClaims(WEB_SYSTEM_USER_ID)],
    ["the web principal's sub with no principal claim", { role: "authenticated", sub: WEB_SYSTEM_USER_ID }],
    ["the service key (no sub)", SERVICE],
  ];
  for (const [label, claims] of notSystem) {
    eq(`dam_is_system() is false for ${label}`, await asPrincipal(db, claims, (tx) => val(tx, `select dam_is_system()`)), false);
  }
  eq("dam_is_system() is false with no claims at all", await val(db, `select dam_is_system()`), false);
  eq("a system token has no role (dam_current_role() is null)", await asPrincipal(db, systemClaims(), (tx) => val(tx, `select dam_current_role()::text`)), null);
  await expectError("activating a system principal", () => inTx(db, (tx) => tx.query(`update dam_users set is_active = true where id = $1`, [WEB_SYSTEM_USER_ID])), "23514");
}

// =================================================================================================
// 5. dam_provision_user
// =================================================================================================
const provision = (tx, email, name = null, picture = null) => one(tx, `select * from dam_provision_user($1, $2, $3)`, [email, name, picture]);

async function provisioningChecks(db) {
  const created = await asPrincipal(db, systemClaims(), async (tx) => {
    const first = await provision(tx, "  New.Person@DWP.com ", "New Person");
    const again = await provision(tx, "new.person@dwp.com", "Another Name");
    const n = await val(tx, `select count(*)::int from dam_users where email = 'new.person@dwp.com'`);
    return { first, again, n };
  });
  const f = created.first;
  eq("a new dwp.com person: created, email normalised, viewer, active, cross-studio (users.default_cross_studio_visibility)",
    [f.created, f.email, f.display_name, f.role, f.is_active, f.cross_studio_visibility, f.deleted_at],
    [true, "new.person@dwp.com", "New Person", "viewer", true, true, null]);
  eq("a second call is idempotent: same row, created false, name unchanged, still one row",
    [created.again.created, created.again.id === f.id, created.again.display_name, created.n], [false, true, "New Person", 1]);

  const guest = await asPrincipal(db, systemClaims(), (tx) => provision(tx, "Guest@Example.org"));
  eq("a person outside users.auto_activate_domains is created inactive, without cross-studio",
    [guest.created, guest.email, guest.role, guest.is_active, guest.cross_studio_visibility, guest.display_name],
    [true, "guest@example.org", "viewer", false, false, "guest"]);
  eq("a sub-domain of dwp.com is not dwp.com", (await asPrincipal(db, systemClaims(), (tx) => provision(tx, "someone@mail.dwp.com"))).is_active, false);

  await expectError("a person's own token", () => asPrincipal(db, as(1), (tx) => provision(tx, "a.b@dwp.com")), "42501", /system principal required/);
  await expectError("the global admin person's token", () => asPrincipal(db, as(5), (tx) => provision(tx, "a.b@dwp.com")), "42501", /system principal required/);
  await expectError("a system claim naming a person", () => asPrincipal(db, systemClaims(U(1)), (tx) => provision(tx, "a.b@dwp.com")), "42501");
  await expectError("anon", () => asPrincipal(db, ANON, (tx) => provision(tx, "a.b@dwp.com")), "42501", /permission denied/);
  await expectError("an invalid email", () => asPrincipal(db, systemClaims(), (tx) => provision(tx, "not-an-email")), "22023");
  await expectError("a system-principal address", () => asPrincipal(db, systemClaims(), (tx) => provision(tx, "web@system.dam.invalid")), "22023");
  await expectOk("the service key and a direct (no claims) connection may provision", async () => {
    const s = await asPrincipal(db, SERVICE, (tx) => provision(tx, "service.made@dwp.com"));
    const d = await inTx(db, (tx) => provision(tx, "direct.made@dwp.com"));
    return s.created === true && d.created === true && d.is_active === true;
  });

  // An existing row keeps what administrators set.
  const existing = await inTx(db, async (tx) => {
    await become(tx, systemClaims());
    const r = await provision(tx, "fixture.singapore.editor@dwp.com", "Renamed Person");
    await becomeOwner(tx);
    const stored = await one(tx, `select role::text as role, is_active, cross_studio_visibility, display_name from dam_users where id = $1`, [U(2)]);
    return { r, stored };
  });
  eq("an existing active user: found (created false), role, activation, cross-studio and name unchanged",
    [existing.r.id, existing.r.created, existing.r.role, existing.r.is_active, existing.r.cross_studio_visibility, existing.r.display_name],
    [U(2), false, "viewer", true, false, "Fixture Singapore Editor"]);
  eq("... and the stored row is unchanged too", existing.stored, { role: "viewer", is_active: true, cross_studio_visibility: false, display_name: "Fixture Singapore Editor" });
  const promoted = await inTx(db, async (tx) => {
    await tx.query(`update dam_users set role = 'editor', cross_studio_visibility = true where id = $1`, [U(1)]);
    await become(tx, systemClaims());
    return provision(tx, "fixture.bangkok.viewer@dwp.com");
  });
  eq("an administrator's promotion survives the next sign-in", [promoted.role, promoted.cross_studio_visibility], ["editor", true]);
  const inactive = await inTx(db, async (tx) => {
    const before = await val(tx, `select login_count from dam_users where id = $1`, [U(6)]);
    await become(tx, systemClaims());
    const r = await provision(tx, "fixture.inactive@dwp.com");
    await becomeOwner(tx);
    return { r, before, after: await val(tx, `select login_count from dam_users where id = $1`, [U(6)]) };
  });
  eq("an inactive user stays inactive and gets no sign-in bookkeeping", [inactive.r.is_active, inactive.r.created, inactive.after === inactive.before], [false, false, true]);

  // The users guard trigger admits the bookkeeping under the system token, and only there.
  const booked = await inTx(db, async (tx) => {
    await tx.query(`update dam_users set last_login_at = now() - interval '1 hour', login_count = 3, sso_picture_url = null where id = $1`, [U(1)]);
    await become(tx, systemClaims());
    await provision(tx, "fixture.bangkok.viewer@dwp.com", null, "https://example.invalid/p.jpg");
    await becomeOwner(tx);
    return one(tx, `select login_count, last_login_at = now() as stamped, sso_picture_url, role::text as role from dam_users where id = $1`, [U(1)]);
  });
  eq("bookkeeping under the system token passes the users guard (login_count, last_login_at, picture)", booked,
    { login_count: 4, stamped: true, sso_picture_url: "https://example.invalid/p.jpg", role: "viewer" });
  const throttled = await inTx(db, async (tx) => {
    await tx.query(`update dam_users set last_login_at = now() - interval '5 minutes', login_count = 3 where id = $1`, [U(1)]);
    await become(tx, systemClaims());
    await provision(tx, "fixture.bangkok.viewer@dwp.com");
    await becomeOwner(tx);
    return val(tx, `select login_count from dam_users where id = $1`, [U(1)]);
  });
  eq("bookkeeping is throttled: a sign-in within 15 minutes of the last writes nothing", throttled, 3);
  await expectError("the same counter update under the person's own token (the guard is active)",
    () => asPrincipal(db, as(1), (tx) => tx.query(`update dam_users set login_count = login_count + 1 where id = $1`, [U(1)])), "42501");
}

// =================================================================================================
// 6. The search row
// =================================================================================================
async function searchRowChecks(db) {
  const drained = await asPrincipal(db, SERVICE, (tx) => val(tx, `select dam_reindex_stale(10000)`), { commit: true });
  check("select dam_reindex_stale(10000) as the service connection returns a row count", Number.isInteger(drained) && drained >= 0, `returned ${drained}`);
  eq("after the drain there is one search row per asset",
    await one(db, `select (select count(*) from dam_assets)::int as assets, (select count(*) from dam_asset_search)::int as search_rows`), { assets: 26, search_rows: 26 });
  eq("a second drain finds nothing to do", await asPrincipal(db, SERVICE, (tx) => val(tx, `select dam_reindex_stale(10000)`)), 0);
  await freshCheck("every row equals its base rows (studios, level, projects, keywords + ancestors, copied columns), m2's helpers, and is fresh", db);

  // The fixture's design, row by row.
  const s = new Map((await rows(db, `select asset_id, studio_ids, access_level_id, project_ids, status::text as status, ingest_relative_path from dam_asset_search`)).map((r) => [num(r.asset_id), r]));
  const off = (f) => ALL.filter((n) => !f(n, s.get(n))).join(", ");
  check("studio_ids as the fixture was designed (home studios; 13/14's own Malaysia ignored; 21, 22, 24-26 empty)", off((n, r) => show(r?.studio_ids) === show(studiosOf(n))) === "", `wrong for ${off((n, r) => show(r?.studio_ids) === show(studiosOf(n)))}`);
  check("access_level_id as designed (10 explicit Restricted; 24, 26 Firm-wide by category; the rest Studio)", off((n, r) => r?.access_level_id === levelOf(n)) === "", `wrong for ${off((n, r) => r?.access_level_id === levelOf(n))}`);
  check("project_ids as designed (one project each; 23-26 none)", off((n, r) => show(r?.project_ids) === show(projectOf(n) ? [P(projectOf(n))] : [])) === "");
  check("status: only 03 is pending", off((n, r) => r?.status === (n === PENDING ? "pending" : "approved")) === "");
  const paths = new Map((await rows(db, `select id, ingest_relative_path from dam_assets`)).map((r) => [num(r.id), r.ingest_relative_path]));
  check("ingest_relative_path is copied for every asset", off((n, r) => r?.ingest_relative_path === paths.get(n) && typeof paths.get(n) === "string") === "");
  const a1 = await one(db, `select asset_keyword_ids, project_keyword_ids from dam_asset_search where asset_id = $1`, [A(1)]);
  eq("asset 01's asset keywords: its seven direct links (the second Time of Day tag was never linked)", [...a1.asset_keyword_ids].sort(), [1, 10, 14, 16, 19, 22, 26].map(AK));
  eq("asset 01's project keywords: project 01's five Sector links", [...a1.project_keyword_ids].sort(), [1, 4, 6, 12, 15].map(PK));

  // Ancestor expansion, with a child keyword the fixture lacks.
  await inTx(db, async (tx) => {
    const child = AK(901);
    await tx.query(`insert into dam_keywords (id, category_id, parent_id, name) values ($1, $2, $3, 'Infinity Pool')`, [child, KC.spaceType, AK(1)]);
    await tx.query(`insert into dam_keyword_links (keyword_id, target_type, target_id) values ($1, 'asset', $2)`, [child, A(2)]);
    const a2 = await val(tx, `select asset_keyword_ids from dam_asset_search where asset_id = $1`, [A(2)]);
    check("a link to a child keyword puts the child and its parent in asset_keyword_ids", a2.includes(child) && a2.includes(AK(1)), show(a2));
    await tx.query(`insert into dam_keyword_links (keyword_id, target_type, target_id) values ($1, 'project', $2)`, [PK(14), P(4)]);
    const pk = await rows(tx, `select asset_id, project_keyword_ids from dam_asset_search where asset_id = any($1::uuid[])`, [pgArray([15, 16, 17].map(A))]);
    check("a project link to a depth-3 Sector keyword gives that project's assets its two ancestors too",
      pk.length === 3 && pk.every((r) => [PK(14), PK(5), PK(1)].every((k) => r.project_keyword_ids.includes(k))), show(pk));
    await freshCheck("rows still equal their base rows after the keyword inserts", tx);
  });

  // The drain alone backfills (the migration writes no rows; scripts/v2-backfill-search.mjs loops this).
  await inTx(db, async (tx) => {
    await tx.exec(`delete from dam_asset_search`);
    await become(tx, SERVICE);
    eq("with no search rows, dam_reindex_stale(10) rebuilds 10", await val(tx, `select dam_reindex_stale(10)`), 10);
    await becomeOwner(tx);
    sameSet("... the 10 oldest assets (created_at, then id: through the tie group)", (await rows(tx, `select asset_id from dam_asset_search`)).map((r) => num(r.asset_id)), [17, 26, 23, 1, 2, 3, 4, 5, 25, 11]);
    await become(tx, SERVICE);
    eq("then the other 16", await val(tx, `select dam_reindex_stale(10000)`), 16);
    eq("then nothing", await val(tx, `select dam_reindex_stale(10000)`), 0);
    await becomeOwner(tx);
    await freshCheck("rows written by the drain alone equal their base rows", tx);
  });

  // The reindex triggers (contract section 4): synchronous for asset- and project-scoped changes.
  await inTx(db, async (tx) => {
    await tx.query(`update dam_assets set title = 'Zebra Crossing' where id = $1`, [A(1)]);
    eq("an asset title update rebuilds its row in the same statement (title, search_tsv, fresh)",
      await one(tx, `select title, search_tsv @@ to_tsquery('simple', 'zebra') as found, indexed_at >= updated_at as fresh from dam_asset_search where asset_id = $1`, [A(1)]),
      { title: "Zebra Crossing", found: true, fresh: true });
  });
  await inTx(db, async (tx) => {
    const akw = async () => val(tx, `select asset_keyword_ids from dam_asset_search where asset_id = $1`, [A(1)]);
    const link = LINK(902);
    await tx.query(`insert into dam_keyword_links (id, keyword_id, target_type, target_id) values ($1, $2, 'asset', $3)`, [link, AK(2), A(1)]);
    check("a keyword link insert adds the keyword to asset_keyword_ids", (await akw()).includes(AK(2)));
    await tx.query(`delete from dam_keyword_links where id = $1`, [link]);
    check("deleting the link removes it again", !(await akw()).includes(AK(2)));
    await tx.query(`update dam_keyword_links set deleted_at = now() where id = $1`, [LINK(28)]);
    check("soft-deleting a fixture link (swimming pool on 01) removes that keyword", !(await akw()).includes(AK(1)));
    await freshCheck("rows equal their base rows after the link changes", tx);
  });
  await inTx(db, async (tx) => {
    await tx.query(`update dam_projects set name = 'Zebra Estate' where id = $1`, [P(1)]);
    sameSet("a project rename reaches its five assets' search_tsv and trigram_text, and no others",
      (await rows(tx, `select asset_id from dam_asset_search where search_tsv @@ to_tsquery('simple', 'zebra') and trigram_text like '%zebra estate%'`)).map((r) => num(r.asset_id)), range(1, 5));
    eq("... synchronously (nothing is left stale)", await staleRows(tx), []);
  });
  await inTx(db, async (tx) => {
    const studios = async (ns) => (await rows(tx, `select studio_ids from dam_asset_search where asset_id = any($1::uuid[]) order by asset_id`, [pgArray(ns.map(A))])).map((r) => r.studio_ids);
    await tx.query(`update dam_projects set studio_id = $1 where id = $2`, [ST.london, P(1)]);
    eq("a project's home studio change moves its assets' studio_ids", await studios(range(1, 5)), range(1, 5).map(() => [ST.london]));
    await tx.query(`insert into dam_project_studios (project_id, studio_id) values ($1, $2)`, [P(3), ST.malaysia]);
    eq("a contributing studio joins the home studio (sorted)", await studios(SGP), SGP.map(() => [ST.malaysia, ST.singapore]));
    await tx.query(`update dam_project_studios set deleted_at = now() where project_id = $1`, [P(3)]);
    eq("soft-deleting it takes it away again", await studios(SGP), SGP.map(() => [ST.singapore]));
    await tx.query(`insert into dam_project_assets (project_id, asset_id, rank) values ($1, $2, 6)`, [P(1), A(24)]);
    eq("linking Firm-wide asset 24 to project 01: its studios and level now come from the project (D-362)",
      await one(tx, `select project_ids, studio_ids, access_level_id from dam_asset_search where asset_id = $1`, [A(24)]),
      { project_ids: [P(1)], studio_ids: [ST.london], access_level_id: LV.studio });
    await freshCheck("rows equal their base rows after the project changes", tx);
  });

  // Category and keyword changes mark rows stale; the drain rebuilds them (contract section 4).
  await inTx(db, async (tx) => {
    await tx.query(`update dam_categories set name = 'Project Photos' where id = $1`, [CAT.photo]);
    sameSet("renaming a category marks exactly its 21 assets stale", await staleRows(tx), PHOTO);
    eq("... and leaves their content for the drain", await val(tx, `select count(*)::int from dam_asset_search where search_tsv @@ to_tsquery('simple', 'photos')`), 0);
    eq("the drain rebuilds the 21", await val(tx, `select dam_reindex_stale(10000)`), 21);
    sameSet("then the new name is searchable on exactly those rows",
      (await rows(tx, `select asset_id from dam_asset_search where search_tsv @@ to_tsquery('simple', 'photos')`)).map((r) => num(r.asset_id)), PHOTO);
    await freshCheck("rows equal their base rows after the category drain", tx);
  });
  await inTx(db, async (tx) => {
    await tx.query(`update dam_keywords set name = 'carrara marble' where id = $1`, [AK(8)]);
    sameSet("renaming asset keyword 'marble' marks its four assets stale", await staleRows(tx), [3, 6, 11, 18]);
    eq("the drain rebuilds the four", await val(tx, `select dam_reindex_stale(10000)`), 4);
    sameSet("then 'carrara' is searchable on them",
      (await rows(tx, `select asset_id from dam_asset_search where search_tsv @@ to_tsquery('simple', 'carrara')`)).map((r) => num(r.asset_id)), [3, 6, 11, 18]);
  });
  await inTx(db, async (tx) => {
    // Project 05 keeps only its depth-3 link (Showflat), so a rename of the root reaches it only
    // through the keyword's subtree.
    await tx.query(`update dam_keyword_links set deleted_at = now() where id = any($1::uuid[])`, [pgArray([LINK(22), LINK(23)])]);
    eq("project 05 keeps Lifestyle and Residential as ancestors of Showflat", [...(await val(tx, `select project_keyword_ids from dam_asset_search where asset_id = $1`, [A(18)]))].sort(), [1, 6, 16].map(PK));
    eq("... and nothing is stale", await staleRows(tx), []);
    await tx.query(`update dam_keywords set name = 'Lifestyle Portfolio' where id = $1`, [PK(1)]);
    sameSet("renaming Sector root Lifestyle marks the assets of projects linked to it or any descendant", await staleRows(tx), [...range(1, 10), 18, 19, 20]);
    eq("the drain rebuilds the 13", await val(tx, `select dam_reindex_stale(10000)`), 13);
    check("then 'portfolio' is searchable on project 05's assets", (await val(tx, `select count(*)::int from dam_asset_search where asset_id = any($1::uuid[]) and search_tsv @@ to_tsquery('simple', 'portfolio')`, [pgArray([18, 19, 20].map(A))])) === 3);
    await freshCheck("rows equal their base rows after the keyword drain", tx);
  });
  await inTx(db, async (tx) => {
    await tx.query(`update dam_keywords set descendant_ids = '{}' where id = $1`, [PK(1)]);
    eq("a change to descendant_ids alone marks nothing stale", await staleRows(tx), []);
  });

  // Writers and schedule.
  const writers = ["dam_rebuild_asset_search_batch(uuid[])", "dam_rebuild_asset_search(uuid)", "dam_mark_search_stale(uuid[])", "dam_reindex_stale(integer)"];
  const acl = await rows(db, `select f, has_function_privilege('authenticated', f, 'EXECUTE') as auth, has_function_privilege('anon', f, 'EXECUTE') as anon,
    has_function_privilege('service_role', f, 'EXECUTE') as svc from unnest($1::text[]) as f`, [pgArray(writers)]);
  check("the four writers: not executable by authenticated or anon, executable by service_role", acl.length === 4 && acl.every((r) => !r.auth && !r.anon && r.svc), show(acl));
  await expectError("a signed-in user calling dam_reindex_stale", () => asPrincipal(db, as(5), (tx) => tx.query(`select dam_reindex_stale(10)`)), "42501");
  await expectError("a signed-in user calling dam_rebuild_asset_search_batch", () => asPrincipal(db, as(5), (tx) => tx.query(`select dam_rebuild_asset_search_batch($1::uuid[])`, [pgArray([A(1)])])), "42501");
  eq("cron.job schedules dam-reindex-stale every minute", await rows(db, `select jobname, schedule, command from cron.job where jobname = 'dam-reindex-stale'`),
    [{ jobname: "dam-reindex-stale", schedule: "* * * * *", command: "select public.dam_reindex_stale(2000)" }]);
}

// =================================================================================================
// 7. Taxonomy integrity
// =================================================================================================
const addLink = (tx, keyword, type, target) => tx.query(`insert into dam_keyword_links (keyword_id, target_type, target_id) values ($1, $2, $3)`, [keyword, type, target]);
const keywordRow = (tx, id) => one(tx, `select slug, path, depth, namespace::text as namespace, descendant_ids from dam_keywords where id = $1`, [id]);

async function taxonomyChecks(db) {
  await expectError("a link to an asset that does not exist", () => inTx(db, (tx) => addLink(tx, AK(2), "asset", "99999999-9999-4999-8999-999999999999")), "23503");
  await expectError("a link to a trashed asset", () => inTx(db, async (tx) => {
    await tx.query(`update dam_assets set deleted_at = now() where id = $1`, [A(26)]);
    await addLink(tx, AK(2), "asset", A(26));
  }), "23503");
  await expectError("a project keyword on an asset (namespace mismatch)", () => inTx(db, (tx) => addLink(tx, PK(1), "asset", A(1))), "23514");
  await expectError("an asset keyword on a project (namespace mismatch)", () => inTx(db, (tx) => addLink(tx, AK(2), "project", P(1))), "23514");
  await expectError("a second Time of Day keyword on asset 01 (exclusive; it has dusk)", () => inTx(db, (tx) => addLink(tx, AK(12), "asset", A(1))), "23505");
  await expectError("a second View keyword on asset 01 (exclusive; it has exterior facade)", () => inTx(db, (tx) => addLink(tx, AK(13), "asset", A(1))), "23505");
  await expectError("two Time of Day keywords in one multi-row insert", () => inTx(db, (tx) => tx.query(
    `insert into dam_keyword_links (keyword_id, target_type, target_id) values ($1, 'asset', $3), ($2, 'asset', $3)`, [AK(11), AK(12), A(24)])), "23505");
  await expectError("the service key is held to the exclusive rule too", () => inTx(db, async (tx) => {
    await become(tx, SERVICE);
    await addLink(tx, AK(12), "asset", A(1));
  }), "23505");
  await expectOk("a second keyword in a non-exclusive category (Space Type) is accepted", () => inTx(db, (tx) => addLink(tx, AK(2), "asset", A(1))));
  await expectOk("swapping Time of Day by soft-deleting dusk, then linking night, is accepted", () => inTx(db, async (tx) => {
    await tx.query(`update dam_keyword_links set deleted_at = now() where id = $1`, [LINK(29)]);
    await addLink(tx, AK(12), "asset", A(1));
  }));

  const inserted = await inTx(db, (tx) => one(tx, `insert into dam_keywords (category_id, parent_id, name) values ($1, $2, 'Infinity Edge Pool')
      returning slug, path, depth, namespace::text as namespace`, [KC.spaceType, AK(1)]));
  eq("a keyword inserted with only category, parent and name gets slug, path, depth and namespace", inserted,
    { slug: "infinity-edge-pool", path: "swimming-pool/infinity-edge-pool", depth: 2, namespace: "asset" });
  const root = await inTx(db, (tx) => one(tx, `insert into dam_keywords (category_id, name) values ($1, 'Mid-Century Modern')
      returning slug, path, depth, namespace::text as namespace`, [KC.designStyle]));
  eq("a root inserted with only category and name", root, { slug: "mid-century-modern", path: "mid-century-modern", depth: 1, namespace: "asset" });

  eq("Sector roots cache their live subtree in path order (maintained while the fixture loaded)",
    (await keywordRow(db, PK(1))).descendant_ids, [5, 14, 4, 12, 11, 13, 6, 16, 15].map(PK));
  eq("non-root keywords cache nothing", await val(db, `select count(*)::int from dam_keywords where parent_id is not null and cardinality(descendant_ids) > 0`), 0);

  await inTx(db, async (tx) => {
    await tx.query(`update dam_keywords set parent_id = $1 where id = $2`, [PK(2), PK(4)]);
    const moved = await rows(tx, `select id, path, depth from dam_keywords where id = any($1::uuid[]) order by path`, [pgArray([4, 11, 12, 13].map(PK))]);
    eq("reparenting Hospitality under Workplace rewrites its path and its children's",
      moved.map((r) => `${r.path}:${r.depth}`),
      ["workplace/hospitality:2", "workplace/hospitality/boutique-lifestyle:3", "workplace/hospitality/luxury-resort:3", "workplace/hospitality/serviced-apartments:3"]);
    sameSet("... Lifestyle's descendant_ids lose the moved subtree", (await keywordRow(tx, PK(1))).descendant_ids, [5, 14, 6, 16, 15].map(PK));
    sameSet("... Workplace's gain it", (await keywordRow(tx, PK(2))).descendant_ids, [7, 8, 17, 18, 19, 4, 11, 12, 13].map(PK));
  });
  await inTx(db, async (tx) => {
    await tx.query(`update dam_keywords set name = 'Hotels' where id = $1`, [PK(4)]);
    eq("a rename re-derives the slug and rewrites the subtree's paths",
      (await rows(tx, `select path from dam_keywords where id = any($1::uuid[]) order by path`, [pgArray([4, 11].map(PK))])).map((r) => r.path),
      ["lifestyle/hotels", "lifestyle/hotels/luxury-resort"]);
  });
  await expectError("a cycle: Lifestyle under its own grandchild Luxury Resort", () => inTx(db, (tx) => tx.query(`update dam_keywords set parent_id = $1 where id = $2`, [PK(11), PK(1)])), "23514");
  await expectError("a cycle: a keyword under itself", () => inTx(db, (tx) => tx.query(`update dam_keywords set parent_id = id where id = $1`, [PK(6)])), "23514");
  await expectError("a child under a depth-3 Sector keyword (max_depth 3)", () => inTx(db, (tx) => tx.query(`insert into dam_keywords (category_id, parent_id, name) values ($1, $2, 'Too Deep')`, [KC.sector, PK(11)])), "23514");
  await expectError("a child under dusk (Time of Day, max_depth 1)", () => inTx(db, (tx) => tx.query(`insert into dam_keywords (category_id, parent_id, name) values ($1, $2, 'Early Dusk')`, [KC.timeOfDay, AK(10)])), "23514");
  await expectError("a move that pushes a descendant past max_depth (Residential under Hospitality)", () => inTx(db, (tx) => tx.query(`update dam_keywords set parent_id = $1 where id = $2`, [PK(4), PK(6)])), "23514");

  eq("soft-deleting the links of a trashed asset (deleted_at only) passes the target guard",
    await inTx(db, async (tx) => {
      await tx.query(`update dam_assets set deleted_at = now() where id = $1`, [A(1)]);
      const links = await tx.query(`update dam_keyword_links set deleted_at = now() where target_type = 'asset' and target_id = $1`, [A(1)]);
      const ids = await tx.query(`update dam_external_ids set deleted_at = now() where target_type = 'asset' and target_id = $1`, [A(1)]);
      return [links.affectedRows, ids.affectedRows];
    }), [7, 2]);
  eq("soft-deleting the keyword links of a trashed project passes too",
    await inTx(db, async (tx) => {
      await tx.query(`update dam_projects set deleted_at = now() where id = $1`, [P(6)]);
      return (await tx.query(`update dam_keyword_links set deleted_at = now() where target_type = 'project' and target_id = $1`, [P(6)])).affectedRows;
    }), 3);

  await expectError("changing an external id's external_id", () => inTx(db, (tx) => tx.query(`update dam_external_ids set external_id = 'changed' where id = $1`, [EXT(1)])), "23514");
  await expectError("changing an external id's system", () => inTx(db, (tx) => tx.query(`update dam_external_ids set system = 'openasset' where id = $1`, [EXT(1)])), "23514");
  await expectOk("rewriting system and external_id with their own values is allowed", () => inTx(db, (tx) => tx.query(
    `update dam_external_ids set system = system, external_id = external_id, external_url = external_url where id = $1`, [EXT(1)])));
  await expectOk("replacing a v1 id is a soft delete plus an insert", () => inTx(db, async (tx) => {
    await tx.query(`update dam_external_ids set deleted_at = now() where id = $1`, [EXT(1)]);
    await tx.query(`insert into dam_external_ids (target_type, target_id, system, external_id) values ('asset', $1, 'dwp_dam_v1', $2)`, [A(1), V1(901)]);
  }));
  await expectError("an external id for an asset that does not exist", () => inTx(db, (tx) => tx.query(
    `insert into dam_external_ids (target_type, target_id, system, external_id) values ('asset', '99999999-9999-4999-8999-999999999999', 'openasset', 'x')`)), "23503");
}

// =================================================================================================
// 8. The search RPCs
// =================================================================================================
async function searchRpcChecks(db) {
  // ---- privileges
  const acl = await rows(db, `select f, has_function_privilege('authenticated', f, 'EXECUTE') as auth, has_function_privilege('anon', f, 'EXECUTE') as anon,
    has_function_privilege('service_role', f, 'EXECUTE') as svc from unnest($1::text[]) as f`,
  [pgArray(["dam_search_assets(jsonb)", "dam_search_assets_count(jsonb)", "dam_search_facets(jsonb)", "dam_search_sql_where(jsonb)"])]);
  eq("authenticated executes the three RPCs but not dam_search_sql_where; anon none; service_role all",
    acl.map((r) => [r.f, r.auth, r.anon, r.svc]),
    [["dam_search_assets(jsonb)", true, false, true], ["dam_search_assets_count(jsonb)", true, false, true],
      ["dam_search_facets(jsonb)", true, false, true], ["dam_search_sql_where(jsonb)", false, false, true]]);
  await expectError("a signed-in user calling dam_search_sql_where", () => asPrincipal(db, as(5), (tx) => tx.query(`select dam_search_sql_where('{}')`)), "42501");

  // ---- visibility per principal (SPEC 3.5.5 as the contract's section 5 states it)
  const principals = [
    ["global admin (05) sees every live asset", as(5), ALL],
    ["Bangkok viewer (01): Bangkok's approved studio-level assets plus firm-wide and empty-studio ones", as(1), [...minus(BKK, [PENDING, RESTRICTED]), ...OPEN]],
    ["Singapore viewer with an editor override (02): Singapore, firm-wide, empty-studio", as(2), [...SGP, ...OPEN]],
    ["australia region-group member (03): the group's assets through its children", as(3), [...AUS, ...OPEN]],
    ["cross-studio viewer (04): approved studio-level assets of every studio", as(4), minus(ALL, [PENDING, RESTRICTED])],
    ["viewer with no studio and no cross-studio (07): only firm-wide and empty-studio assets", as(7), OPEN],
    ["inactive user (06) sees nothing", as(6), []],
  ];
  for (const [label, claims, want] of principals) checkVisible(`visibility: ${label}`, await visibleAs(db, claims), want);
  for (const [label, claims] of [
    ["no sub", { role: "authenticated", aud: "authenticated" }],
    ["the service key", SERVICE],
    ["the web system principal", systemClaims()],
    ["an unknown sub", userClaims("99999999-9999-4999-8999-999999999999")],
  ]) {
    checkVisible(`visibility: ${label} sees nothing`, await visibleAs(db, claims), []);
  }

  // ---- the rules, one at a time (setup as the owner, search as the principal, rolled back)
  const promote7 = (tx) => tx.query(`update dam_users set role = 'editor' where id = $1`, [U(7)]);
  const grant = (user, expires = null) => (tx) => tx.query(`insert into dam_access_grants (access_level_id, user_id, expires_at, note) values ($1, $2, $3, 'test')`, [LV.restricted, user, expires]);
  check("pending asset 03 is hidden from viewers (01 member, 04 cross-studio)",
    !(await visibleAs(db, as(1))).nums.includes(PENDING) && !(await visibleAs(db, as(4))).nums.includes(PENDING));
  checkVisible("a global editor sees pending 03 and every studio-level asset, but not grant_only 10 without a grant",
    await visibleAfter(db, promote7, as(7)), minus(ALL, [RESTRICTED]));
  // created_by is pinned on UPDATE (SCHEMA.sql dam_set_updated_at), so the creator is set at insert:
  // a pending, Restricted, Bangkok asset uploaded by viewer 07, who has no Bangkok membership.
  const uploadBy7 = (tx) => tx.query(`insert into dam_assets (id, filename, category_id, status, access_level_id, studio_id, created_by)
      values ($1, 'Own_Upload.jpg', $2, 'pending', $3, $4, $5)`, [A(905), CAT.photo, LV.restricted, ST.bangkok, U(7)]);
  checkVisible("the creator of a pending, Restricted, other-studio asset sees it (creator pass) on top of what they saw",
    await visibleAfter(db, uploadBy7, as(7)), [...OPEN, 905]);
  check("... and nobody else below global admin does (Bangkok member 01, cross-studio 04)",
    !(await visibleAfter(db, uploadBy7, as(1))).nums.includes(905) && !(await visibleAfter(db, uploadBy7, as(4))).nums.includes(905));
  const pending11 = (tx) => tx.query(`update dam_assets set status = 'pending' where id = $1`, [A(11)]);
  check("a pending Singapore asset is visible to the Singapore editor override (02)", (await visibleAfter(db, pending11, as(2))).nums.includes(11));
  check("... and hidden from the cross-studio viewer (04)", !(await visibleAfter(db, pending11, as(4))).nums.includes(11));
  checkVisible("grant_only 10: a global editor with a live grant sees it", await visibleAfter(db, async (tx) => { await promote7(tx); await grant(U(7))(tx); }, as(7)), ALL);
  check("grant_only 10: an expired grant opens nothing",
    !(await visibleAfter(db, async (tx) => { await promote7(tx); await grant(U(7), new Date(Date.now() - 86400000).toISOString())(tx); }, as(7))).nums.includes(RESTRICTED));
  check("grant_only 10: a viewer with a grant is still below the editor floor", !(await visibleAfter(db, grant(U(4)), as(4))).nums.includes(RESTRICTED));
  check("a trashed asset is hidden even from the global admin",
    !(await visibleAfter(db, (tx) => tx.query(`update dam_assets set deleted_at = now() where id = $1`, [A(24)]), as(5))).nums.includes(24));

  // ---- filters, as the global admin so that visibility is every asset
  const GA = as(5);
  const filters = [
    ["q: a project name", { q: "Khao" }, range(1, 5)],
    ["q: filename words (KYR)", { q: "KYR" }, range(1, 5)],
    ["q: a keyword name", { q: "marble" }, [3, 6, 11, 18]],
    ["q: websearch negation", { q: "marble -pendant" }, [11]],
    ["q: filename, title, project name and project keyword", { q: "Showflat" }, [18, 19, 20]],
    ["q: a project keyword name (Hospitality)", { q: "Hospitality" }, range(1, 10)],
    ["q: accents fold (Café finds Cafe)", { q: "Café" }, [14]],
    ["q: no lexeme is ignored", { q: "!!!" }, ALL],
    ["filename_like: case-insensitive", { filename_like: "kyr_" }, range(1, 5)],
    ["filename_like: _ is literal (no 'Open House')", { filename_like: "Open_House" }, []],
    ["filename_like: % is literal", { filename_like: "Open%Invitation" }, []],
    ["filename_like: a plain substring", { filename_like: "house inv" }, [24]],
    ["keyword_names: one name", { keyword_names: ["marble"] }, [3, 6, 11, 18]],
    ["keyword_names: all must match", { keyword_names: ["marble", "pendant lighting"] }, [3, 6, 18]],
    ["keyword_names: trimmed and case-folded", { keyword_names: [" Marble "] }, [3, 6, 11, 18]],
    ["keyword_names: an unresolvable name matches nothing", { keyword_names: ["marble", "nonexistent"] }, []],
    ["keyword_names: project-namespace names do not resolve", { keyword_names: ["Lifestyle"] }, []],
    ["keyword_ids: any", { keyword_ids: [AK(8), AK(23)] }, [3, 6, 8, 11, 13, 18]],
    ["keyword_ids: all", { keyword_ids: [AK(8), AK(23)], keyword_mode: "all" }, [3, 6, 18]],
    ["project_keyword_names: one name", { project_keyword_names: ["Healthcare"] }, [15, 16, 17]],
    ["project_keyword_names: all must match", { project_keyword_names: ["lifestyle", "residential"] }, [...range(1, 5), 18, 19, 20]],
    ["project_keyword_names: with an ampersand", { project_keyword_names: ["Food & Beverage"] }, range(6, 10)],
    ["project_keyword_names: asset-namespace names do not resolve", { project_keyword_names: ["swimming pool"] }, []],
    ["project_keyword_ids: a root matches through its links", { project_keyword_ids: [PK(3)] }, [15, 16, 17, 21, 22]],
    ["studio_codes: a region group expands to its children", { studio_codes: ["australia"] }, AUS],
    ["studio_codes: a child does not match the group's assets", { studio_codes: ["sydney"] }, []],
    ["studio_codes: case-insensitive", { studio_codes: ["BANGKOK"] }, BKK],
    ["studio_codes: an unknown code matches nothing", { studio_codes: ["nope"] }, []],
    ["studio_codes: an unknown code contributes nothing", { studio_codes: ["nope", "singapore"] }, SGP],
    ["studio_codes: an asset's own studio is ignored when it has a project", { studio_codes: ["malaysia"] }, []],
    ["studio_ids: the region group", { studio_ids: [ST.australia] }, AUS],
    ["path: folder equality", { path: "dwp_Digital_Asset/dwp Projects/THAILAND/Residential/22-0047 Khao Yai Residence/KHAOYAI_HOUSE_HIRES" }, [1, 2, 3]],
    ["path_prefix: a folder and everything under it", { path_prefix: "dwp_Digital_Asset/dwp Projects/THAILAND" }, [1, 2, 3, 6, 7, 8, 9, 10, 18, 19, 20]],
    ["path_prefix: the folder itself and its subfolders", { path_prefix: "dwp_Digital_Asset/_OpenAsset Projects/Australia" }, [15, 16, 23]],
    ["path_prefix: only on a '/' boundary", { path_prefix: "dwp_Digital_Asset/_OpenAsset Projects/Austral" }, []],
    ["path_prefix: _ is literal (no 'dwp Projects')", { path_prefix: "dwp_Digital_Asset/dwp_Projects" }, []],
    ["file_kinds", { file_kinds: ["video"] }, [9, 25]],
    ["file_kinds: two", { file_kinds: ["pdf", "design"] }, [4, 24]],
    ["project_ids: any", { project_ids: [P(1), P(2)] }, range(1, 10)],
    ["project_ids: all", { project_ids: [P(1), P(2)], project_mode: "all" }, []],
    ["category_ids", { category_ids: [CAT.logos, CAT.collateral] }, FIRM],
    ["statuses narrow", { statuses: ["pending"] }, [PENDING]],
    ["filters combine with AND", { studio_codes: ["bangkok"], keyword_names: ["marble"] }, [3, 6, 18]],
    ["three filters", { studio_codes: ["bangkok"], keyword_names: ["marble"], q: "KYR" }, [3]],
    ["unknown keys are ignored", { foo: 1, bar: "x" }, ALL],
    ["JSON null reads as absent", { q: null, limit: null, cursor: null, project_ids: null }, ALL],
  ];
  for (const [label, p, want] of filters) checkVisible(`filter ${label}`, await visibleAs(db, GA, p), want);
  checkVisible("filter statuses never widen: a viewer asking for pending gets nothing", await visibleAs(db, as(1), { statuses: ["pending"] }), []);
  // No fixture asset is filed under a CHILD studio, so file project-less 25 under Sydney.
  const fileUnderSydney = (tx) => tx.query(`update dam_assets set studio_id = $1 where id = $2`, [ST.sydney, A(25)]);
  checkVisible("filter studio_codes: the region group's code expands to an asset filed under its child Sydney",
    await visibleAfter(db, fileUnderSydney, GA, { studio_codes: ["australia"] }), [...AUS, 25]);
  checkVisible("filter studio_codes: the child's own code matches only the child's asset", await visibleAfter(db, fileUnderSydney, GA, { studio_codes: ["sydney"] }), [25]);
  checkVisible("filter studio_ids: the region group's id expands to its child", await visibleAfter(db, fileUnderSydney, GA, { studio_ids: [ST.australia] }), [...AUS, 25]);
  check("visibility: the region-group member (03) sees the Sydney asset through the group's children",
    (await visibleAfter(db, fileUnderSydney, as(3))).nums.includes(25));
  check("visibility: the Bangkok member (01) no longer sees 25 once it has a studio that is not theirs",
    !(await visibleAfter(db, fileUnderSydney, as(1))).nums.includes(25));
  eq("p = SQL null returns every row (default limit 50)", (await asPrincipal(db, GA, (tx) => search(tx, null))).length, 26);
  const literal = await visibleAfter(db, (tx) => tx.query(`insert into dam_assets (id, filename, category_id, status) values
      ($1, '100%_Final.jpg', $4, 'approved'), ($2, '100x_Final.jpg', $4, 'approved'), ($3, '100%xFinal.jpg', $4, 'approved')`,
  [A(901), A(902), A(903), CAT.collateral]), GA, { filename_like: "100%_" });
  sameSet("filter filename_like '100%_' matches only the name holding those two characters literally", literal.nums, [901]);

  // ---- ordering and paging
  const createdAt = new Map((await rows(db, `select id, created_at from dam_assets`)).map((r) => [r.id, r.created_at.getTime()]));
  const reference = (ids, desc) => [...ids].sort((a, b) => (desc ? -1 : 1) * ((createdAt.get(a) - createdAt.get(b)) || byValue(a, b)));
  const gaAll = await asPrincipal(db, GA, (tx) => search(tx, { limit: 200 }));
  eq("default order is created_at desc, asset_id desc (the tie group 15, 13, 12, 11)", gaAll.map((r) => num(r.asset_id)), ORDER_DESC);
  eq("... which is the order the base rows give", gaAll.map((r) => r.asset_id), reference(ALL.map(A), true));
  check("the fixture's tie group is four rows", gaAll.filter((r) => r.created_at.toISOString() === TIE_AT).length === 4);
  for (const [who, claims, visible] of [["global admin", GA, ALL], ["cross-studio viewer", as(4), minus(ALL, [PENDING, RESTRICTED])]]) {
    for (const sort of ["-created_at", "created_at"]) {
      const want = reference(visible.map(A), sort === "-created_at");
      for (const size of [1, 3, 4]) {
        eq(`keyset paging (${who}, ${sort}, limit ${size}): every visible row exactly once, in order`, await walkPages(db, claims, sort, size), want);
      }
    }
  }
  eq("a cursor inside the tie group, written with a +07:00 offset, resumes strictly after it (desc)",
    (await asPrincipal(db, GA, (tx) => search(tx, { limit: 200, cursor: { created_at: "2025-03-14T16:12:44.123+07:00", asset_id: A(13) } }))).map((r) => num(r.asset_id)),
    ORDER_DESC.slice(ORDER_DESC.indexOf(13) + 1));
  eq("a cursor inside the tie group resumes strictly after it (asc)",
    (await asPrincipal(db, GA, (tx) => search(tx, { sort: "created_at", limit: 200, cursor: { created_at: TIE_AT, asset_id: A(12) } }))).map((r) => num(r.asset_id)),
    [...ORDER_DESC].reverse().slice([...ORDER_DESC].reverse().indexOf(12) + 1));
  eq("offset paging: limit 5 offset 5", (await asPrincipal(db, GA, (tx) => search(tx, { limit: 5, offset: 5 }))).map((r) => num(r.asset_id)), ORDER_DESC.slice(5, 10));
  eq("offset is ignored with a cursor", (await asPrincipal(db, GA, (tx) => search(tx, { limit: 3, offset: 9, cursor: { created_at: TIE_AT, asset_id: A(13) } }))).map((r) => num(r.asset_id)), [12, 11, 25]);
  eq("limit 0 clamps to 1, a huge limit to search.max_limit (all 26 fit), no limit uses search.default_limit",
    await asPrincipal(db, GA, async (tx) => [(await search(tx, { limit: 0 })).length, (await search(tx, { limit: 1000000 })).length, (await search(tx, {})).length]), [1, 26, 26]);
  eq("limits follow the settings: max_limit 4 caps an explicit limit, default_limit 2 applies without one",
    await inTx(db, async (tx) => {
      await tx.query(`update dam_settings set value = '4' where key = 'search.max_limit'`);
      await tx.query(`update dam_settings set value = '2' where key = 'search.default_limit'`);
      await become(tx, GA);
      return [(await search(tx, { limit: 100 })).length, (await search(tx, {})).length];
    }), [4, 2]);

  // ---- facets
  const FACETS = ["category_id", "studio_ids", "file_kind", "asset_keyword_ids", "project_keyword_ids", "project_ids", "rights_status", "status"];
  const gaFacets = await asPrincipal(db, GA, (tx) => facetsOf(tx, { facets: FACETS }));
  eq("facets (global admin) equal the counts over the visible rows, top 50, count desc then value", gaFacets, facetsFromRows(gaAll, FACETS));
  eq("facet file_kind (global admin): 22 images, 2 videos, 1 design, 1 pdf", facetPairs(gaFacets, "file_kind"), [["image", 22], ["video", 2], ["design", 1], ["pdf", 1]]);
  eq("facet studio_ids (global admin): Bangkok 13, australia 4, Singapore 4", facetPairs(gaFacets, "studio_ids"), [[ST.bangkok, 13], [ST.australia, 4], [ST.singapore, 4]]);
  eq("facet status (global admin): 25 approved, 1 pending", facetPairs(gaFacets, "status"), [["approved", 25], ["pending", 1]]);
  const v1Rows = (await visibleAs(db, as(1))).rows;
  const v1Facets = await asPrincipal(db, as(1), (tx) => facetsOf(tx, { facets: FACETS }));
  eq("facets (Bangkok viewer) count only what the viewer sees, and leave out status", v1Facets, facetsFromRows(v1Rows, FACETS.filter((f) => f !== "status")));
  eq("facet file_kind (Bangkok viewer): 12 images, 2 videos, 1 design, 1 pdf", facetPairs(v1Facets, "file_kind"), [["image", 12], ["video", 2], ["design", 1], ["pdf", 1]]);
  eq("facet studio_ids (Bangkok viewer): Bangkok 11", facetPairs(v1Facets, "studio_ids"), [[ST.bangkok, 11]]);
  eq("facet category_id (no-studio viewer 07): photography 2, then renderings, logos, collateral 1 each",
    facetPairs(await asPrincipal(db, as(7), (tx) => facetsOf(tx, { facets: ["category_id"] })), "category_id"),
    [[CAT.photo, 2], [CAT.renderings, 1], [CAT.logos, 1], [CAT.collateral, 1]]);
  eq("facet status for a global editor: 24 approved, 1 pending (10 stays hidden)",
    await inTx(db, async (tx) => {
      await promote7(tx);
      await become(tx, as(7));
      return facetPairs(await facetsOf(tx, { facets: ["status"] }), "status");
    }), [["approved", 24], ["pending", 1]]);
  eq("facet status needs a global role of editor: a studio editor override (02) gets none", await asPrincipal(db, as(2), (tx) => facetsOf(tx, { facets: ["status"] })), []);
  eq("facets honour the filters (Bangkok: 11 images, 1 design, 1 video)",
    facetPairs(await asPrincipal(db, GA, (tx) => facetsOf(tx, { studio_codes: ["bangkok"], facets: ["file_kind"] })), "file_kind"), [["image", 11], ["design", 1], ["video", 1]]);
  eq("facets for an inactive user: none", await asPrincipal(db, as(6), (tx) => facetsOf(tx, { facets: FACETS })), []);

  // ---- hydration (joined after the limit)
  const by = new Map(gaAll.map((r) => [num(r.asset_id), r]));
  eq("result columns are exactly the contract's", Object.keys(gaAll[0]), ["asset_id", "created_at", "updated_at", "filename", "title", "category_id", "status",
    "access_level_id", "file_kind", "mime_type", "size_bytes", "project_ids", "studio_ids", "asset_keyword_ids", "project_keyword_ids", "rights_status",
    "completeness_score", "ingest_relative_path", "v1_id", "object_key", "storage_provider", "provider_url", "keyword_names", "project_names", "project_codes", "legacy"]);
  const wrongIds = ALL.filter((n) => by.get(n)?.v1_id !== V1(n));
  check("v1_id is each asset's dwp_dam_v1 external id (all 26)", wrongIds.length === 0, `wrong for ${wrongIds}`);
  const wrongKeys = ALL.filter((n) => { const r = by.get(n); return r?.object_key !== objectKey(n) || r?.storage_provider !== "google_drive" || r?.provider_url !== driveUrl(n); });
  check("object_key, storage_provider and provider_url come from the current version and its location (all 26)", wrongKeys.length === 0, `wrong for ${wrongKeys}`);
  const directNames = new Map();
  for (const r of await rows(db, `select l.target_id, k.name from dam_keyword_links l join dam_keywords k on k.id = l.keyword_id
      where l.target_type = 'asset' and l.deleted_at is null and k.deleted_at is null and k.namespace = 'asset'`)) {
    directNames.set(num(r.target_id), [...(directNames.get(num(r.target_id)) ?? []), r.name]);
  }
  const wrongNames = ALL.filter((n) => show(by.get(n)?.keyword_names) !== show([...(directNames.get(n) ?? [])].sort()));
  check("keyword_names are the direct links' names, by name at equal weight (all 26)", wrongNames.length === 0, `wrong for ${wrongNames}`);
  eq("keyword_names of asset 01", by.get(1)?.keyword_names, ["contemporary luxury", "dusk", "exterior facade", "natural daylight", "swimming pool", "tropical", "warm neutral"]);
  eq("keyword_names of asset 02: 'timber flooring' once, although v1 had two spellings", by.get(2)?.keyword_names, ["contemporary luxury", "day", "interior", "natural daylight", "timber flooring", "warm neutral"]);
  eq("project names and codes: 01, 18 (no code: null kept), 24 (no project)",
    [1, 18, 24].map((n) => [by.get(n)?.project_names, by.get(n)?.project_codes]),
    [[["Khao Yai Residence"], ["22-0047"]], [["Sukhumvit Showflat"], [null]], [[], []]]);
  eq("legacy is exactly the six v1 keys (asset 01)", canon(by.get(1)?.legacy), canon({ folder_id: "1FxFolder010000000000000000000000", publish_permission: "pending",
    uploaded_by: null, macro_portfolio: "Lifestyle", core_sector: "Residential", sub_sectors: ["Super-Luxury Villas"] }));
  eq("legacy carries uploaded_by (24) and publish_permission (03)", [by.get(24)?.legacy?.uploaded_by, by.get(3)?.legacy?.publish_permission], ["fixture.marketing@dwp.com", "restricted"]);
  const hyd = await inTx(db, async (tx) => {
    const child = AK(904);
    await tx.query(`insert into dam_keywords (id, category_id, parent_id, name) values ($1, $2, $3, 'infinity pool')`, [child, KC.spaceType, AK(1)]);
    await tx.query(`insert into dam_keyword_links (keyword_id, target_type, target_id) values ($1, 'asset', $2)`, [child, A(2)]);
    await tx.query(`update dam_keyword_links set weight = 0.5 where id = $1`, [LINK(29)]);
    await become(tx, GA);
    const r = await search(tx, { limit: 200 });
    return { a1: r.find((x) => x.asset_id === A(1)).keyword_names, a2: r.find((x) => x.asset_id === A(2)) };
  });
  eq("keyword_names order by weight first (dusk at 0.5 moves last)", hyd.a1, ["contemporary luxury", "exterior facade", "natural daylight", "swimming pool", "tropical", "warm neutral", "dusk"]);
  check("keyword_names list direct links only; asset_keyword_ids also hold the ancestor",
    hyd.a2.keyword_names.includes("infinity pool") && !hyd.a2.keyword_names.includes("swimming pool") && hyd.a2.asset_keyword_ids.includes(AK(1)), show(hyd.a2.keyword_names));

  // ---- bad input: 22023, naming the key
  const bad = [
    ["p is an array", [], /p must be/],
    ["q is a number", { q: 5 }, /p\.q/],
    ["filename_like is an array", { filename_like: ["a"] }, /p\.filename_like/],
    ["project_ids is a string", { project_ids: "x" }, /p\.project_ids/],
    ["project_ids holds a non-uuid", { project_ids: ["not-a-uuid"] }, /p\.project_ids/],
    ["keyword_mode is not any/all", { keyword_mode: "some" }, /p\.keyword_mode/],
    ["studio_codes is a string", { studio_codes: "bangkok" }, /p\.studio_codes/],
    ["keyword_names holds a number", { keyword_names: [1] }, /p\.keyword_names/],
    ["file_kinds holds an unknown label", { file_kinds: ["bogus"] }, /p\.file_kinds/],
    ["statuses holds an unknown label", { statuses: ["bogus"] }, /p\.statuses/],
    ["sort is unknown", { sort: "name" }, /p\.sort/],
    ["limit is a string", { limit: "10" }, /p\.limit/],
    ["limit is a fraction", { limit: 1.5 }, /p\.limit/],
    ["offset is negative", { offset: -1 }, /p\.offset/],
    ["offset is above 10000", { offset: 10001 }, /p\.offset/],
    ["cursor is a string", { cursor: "abc" }, /p\.cursor/],
    ["cursor has a bad created_at", { cursor: { created_at: "x", asset_id: A(1) } }, /p\.cursor/],
  ];
  for (const [label, p, pattern] of bad) {
    await expectError(`dam_search_assets refuses: ${label}`, () => asPrincipal(db, GA, (tx) => tx.query(`select * from dam_search_assets($1::jsonb)`, [JSON.stringify(p)])), "22023", pattern);
  }
  await expectError("dam_search_assets_count refuses what the search refuses", () => asPrincipal(db, GA, (tx) => countOf(tx, { limit: "x" })), "22023", /p\.limit/);
  await expectError("dam_search_facets refuses a bad filter", () => asPrincipal(db, GA, (tx) => facetsOf(tx, { project_ids: ["x"], facets: ["file_kind"] })), "22023", /p\.project_ids/);
  await expectError("dam_search_facets refuses an unknown facet", () => asPrincipal(db, GA, (tx) => facetsOf(tx, { facets: ["bogus"] })), "22023", /p\.facets/);
}

// =================================================================================================
// Main
// =================================================================================================
async function runRegime(name) {
  regime = name;
  counts = { pass: 0, fail: 0 };
  const t0 = Date.now();
  console.log(`\n=== regime: ${name} ===`);
  let db;
  await section("1. the chain applies with the fixtures", async () => {
    const t = Date.now();
    try {
      db = await createDb({ fixtures: [FIXTURES], defaults: name });
    } catch (e) {
      check("SCHEMA.sql, every migration and fixtures.sql apply", false, e.message);
      return;
    }
    check("SCHEMA.sql, every migration and fixtures.sql apply", true);
    console.log(`     (database built in ${Date.now() - t} ms)`);
    await chainChecks(db);
  });
  if (db) {
    await section("2. grants", () => grantChecks(db));
    await section("3. settings", () => settingsChecks(db));
    await section("4. system principals", () => systemPrincipalChecks(db));
    await section("5. dam_provision_user", () => provisioningChecks(db));
    await section("6. the search row", () => searchRowChecks(db));
    await section("7. taxonomy integrity", () => taxonomyChecks(db));
    await section("8. the search RPCs", () => searchRpcChecks(db));
    await db.close();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSUMMARY [${name}] ${counts.pass + counts.fail} checks: ${counts.pass} passed, ${counts.fail} failed (${secs} s)`);
  totals.pass += counts.pass;
  totals.fail += counts.fail;
}

const started = Date.now();
for (const name of ["legacy", "revoked"]) await runRegime(name);
console.log(`\nTOTAL ${totals.pass + totals.fail} checks: ${totals.pass} passed, ${totals.fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures.length) console.log(`\nFailed:\n  ${failures.join("\n  ")}`);
if (totals.fail > 0) process.exitCode = 1;
