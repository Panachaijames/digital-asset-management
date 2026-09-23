# ROADMAP — Project-Based DAM (OpenAsset-equivalent)

**Status:** Draft for review, 2026-09-15. Companion to `SPEC.md` and `SCHEMA.sql`. Nothing here is built.
**Phase order is the brief's §9 and does not change.** Phase 0 is added in front of it for the decisions and scaffolding that §9 assumes have already happened.
**No dates and no week estimates.** Each phase carries a size (S / M / L / XL) for sequencing only.

---

## How to read this roadmap

**Every phase ships something demonstrable.** "Demonstrable" means a person who does not work on the project can be shown the result in the running application and understands what changed. Every phase therefore has a **demo script**: the exact sequence to run at the end of it. A phase whose demo script cannot be run is not finished, regardless of how much of its checklist is ticked.

**Every phase delivers the same artefact set** (brief §7):

| Artefact | Definition of done |
|---|---|
| Working code | Merged, deployed to the staging environment, demo script runs |
| Migration files | Forward-only numbered migrations in `supabase/migrations/`, applied from scratch by `supabase db reset` in CI |
| Seed data | The phase's entities represented in the seed harness, at both small (local) and large (performance) scale |
| API docs | OpenAPI 3.1 regenerated from the Zod contracts; every new endpoint present with examples |
| README section | What the phase added and how to test it, including the demo script |
| Tests | Unit, contract, and — for anything touching visibility — an extension of the RLS matrix |

**Checklists** are grouped the same way in every phase: *Schema and migrations · API · Jobs and workers · UI screens · Integrations and AI · Tests and performance · Docs and seed*. Every item is written so that it is either done or not done; none is "consider" or "review".

**Entry gates** name what must be true before the phase starts, including which open decisions must be closed. A gate that is not met does not mean the phase waits: it means the phase starts on the part that is not gated, and the gated part is tracked in the phase's risk list.

---

## Phase 0 — Decisions and scaffolding

**Goal.** Close the open decisions that shape the schema, and stand up the repository, the database, the environments and the pipelines so that Phase 1 writes application code rather than infrastructure.

**Size:** M.

### 0.1 Decisions to close

These are the brief's §10 items plus the questions the specification raised. Each names who decides and what it unblocks. **None of them is decided in `SPEC.md`.**

| Item | Decides | Unblocks | If it slips |
|---|---|---|---|
| §10.1 Durable store for originals (Drive / GCS / Supabase Storage) | Product owner with IT | Phase 1 storage adapter configuration, Phase 4 delivery path, the migration plan | Build Phase 1 against Drive behind `StorageProvider`; the decision changes configuration and a backfill job, not the schema |
| §10.2 RFP / proposal AI module in or out | Product owner | Phase 11 exists or does not | Assume out; the DAM ships the text blocks, imagery and query API such a module would consume |
| §10.3 Exact six-tier permission matrix | Studio directors and marketing lead | Phase 1 RLS policies and the whole of Phase 8 | Build the proposed matrix from `SPEC.md` §3.4 as the default; changes are policy edits, not schema |
| §10.4 Migrate the existing library or rebuild clean | Marketing lead with IT | Phase 1 (whether legacy ids are preserved) and Phase 9 (the importer) | Preserve legacy ids regardless — it costs one nullable external-id row and keeps the option open |
| §10.5 Target scale at go-live and in three years | Product owner | Index and partition sizing, the performance corpus, storage budgeting | Proceed on the working assumption: 500,000 assets, 5,000 projects, 600 employees, 150 concurrent users |
| Q6 Design system: brief §2 versus the fleet standard | Product owner | Phase 1 shell and every screen thereafter | Build the shell on design tokens so the palette and type are swappable; do not hand-code either |
| Q7 Identity plumbing: broker SSO versus Supabase Auth | **Decided 2026-09-23 (panachai.t): keep the broker** | Phase 1 auth | — |
| Q8 `/api/v1` compatibility lifetime | Owners of the four consumer sites | Phase 9 shim scope and any sunset communication | Keep the shim indefinitely until a date is agreed |
| Q9 Embedding provider | IT with the product owner | Phase 10 embeddings; the vector dimension is fixed in the schema before Phase 1 | Reserve both vector columns now; a provider change after data exists means a full re-embed |
| Q10 Application name | Product owner | Phase 1 naming, the broker app registration, the hub card | Use a working name; the broker registration is the only costly rename |

- [ ] Every row above has a recorded answer, or an explicit "proceed on the default" with the owner's name against it
- [ ] The answers are written into `SPEC.md` §1.11, replacing the OPEN blocks, and the affected defaults in Appendix A are updated

### 0.2 Scaffolding

- [ ] Monorepo created with the layout in `SPEC.md` §6.14 (`apps/web`, `apps/worker`, `packages/contracts|db|storage|ai|ui|documents`)
- [ ] Supabase projects created for development, staging and production, in the region nearest `asia-southeast3`; extensions enabled (`pgcrypto`, `pg_trgm`, `vector`, `unaccent`, `pg_cron`)
- [ ] `SCHEMA.sql` cut into the Phase 1 migration set; `supabase db reset` applies it from scratch
- [ ] Cloud Run services `dam-web` and `dam-worker` created in `asia-southeast3` with the shapes in `SPEC.md` §6.2; container builds from the repository
- [ ] Single declarative environment source per environment, validated against a typed schema in CI (replacing the two hand-maintained pass-through lists)
- [ ] Secret Manager entries created for every secret named in `SPEC.md` §6.13; no secret value in the repository
- [ ] CI pipeline: typecheck, lint, offline SQL parser, structural schema linter, `supabase db reset`, unit and contract tests
- [ ] Design tokens and the base shell components in `packages/ui`, driven by whichever system Q6 selects
- [ ] Seed harness skeleton that can generate a small local corpus
- [ ] Structured logging, request ids, `/api/health` and `/api/ready` in place before the first feature
- [ ] Error tracking wired with the release version

**Exit criteria.** A developer clones the repository, runs one command, and has a local application talking to a local database with the schema applied and a small seed corpus. CI is green on an empty feature branch.

**Risks.** The environment-delivery rewrite is the one piece of Phase 0 that can silently break production later; it is tested by deploying a no-op revision and diffing the resulting environment against the declared schema.

---

## Phase 1 — Foundation

*Brief §9.1: auth, SSO, roles, RLS, project and asset schema, Drive storage adapter, basic upload, thumbnails, grid browse.*

**Goal.** A signed-in user can upload a file into a project and see it in a grid, with visibility enforced by the database rather than the interface.

**Size:** XL.

**Entry gates.** Phase 0 complete. Q6 (design system), Q7 (identity) and §10.5 (scale) answered or running on defaults. §10.1 answered or Drive assumed.

### Schema and migrations
- [ ] Core tables from `SPEC.md` part 2: `dam_studios`, `dam_clients`, `dam_projects`, `dam_project_aliases`, `dam_project_studios`, `dam_project_assets`, `dam_categories`, `dam_storage_locations`, `dam_assets`, `dam_asset_versions`, `dam_derivatives`, `dam_external_ids`
- [ ] Identity and access tables from part 2B: `dam_users`, `dam_groups`, `dam_group_members`, `dam_user_studios`, `dam_access_levels`, `dam_access_grants`, `dam_api_keys`
- [ ] Governance tables needed from the first write: `dam_audit_log` (partitioned), `dam_usage_events` (partitioned), `dam_jobs`, `dam_settings`
- [ ] All enums from `SPEC.md` §2.0 / DECISIONS §3 that these tables use
- [ ] Six standard columns on every table; `dam_set_updated_at()` trigger on every table; audit triggers on every business table
- [ ] RLS enabled on every table, deny by default, with the helper functions (`dam_current_user_id()`, `dam_is_at_least()`, `dam_can_read_project()`, `dam_can_read_asset()`, and the rest of `SPEC.md` §3.7)
- [ ] Seed rows: the 15 studios (plus the five Australian children), the eight default categories, the four default access levels
- [ ] Partition-creation job and the first three months of log partitions

### API
- [ ] `/api/session` broker exchange, `dam_users` provisioning on first sign-in, minted database JWT with role and studio claims
- [ ] `GET /api/v2/me`
- [ ] Projects: list, get, create, patch, delete, restore
- [ ] Assets: list and search (basic filters only — project, category, studio, file kind), get, patch, delete, restore
- [ ] Upload: create ingest batch, create upload session, finalise, commit
- [ ] `GET /api/v2/assets/{id}/derivative/{kind}` returning a signed CDN URL
- [ ] Error envelope, request ids, rate limiting, `Idempotency-Key` on create endpoints
- [ ] OpenAPI document generated and served

### Jobs and workers
- [ ] Worker service claiming from `dam_jobs` with `FOR UPDATE SKIP LOCKED`, heartbeat, reclaim, retry with backoff, dead-lettering
- [ ] `ingest_finalise`, `hash`, `extract_metadata`, `generate_derivatives` (images only), `reindex_asset`
- [ ] `create_partitions` on a schedule

### UI screens
- [ ] Application shell: sidebar, top bar, appearance modes, feedback control, user menu
- [ ] Sign-in page and session expiry handling (401 on internal APIs, never a redirect)
- [ ] Project list and project detail (overview and assets tabs only)
- [ ] Upload wizard: drag and drop, per-file progress, chunked resumable upload, batch project and category before commit
- [ ] Search and browse grid: thumbnails, density control, infinite scroll, selection
- [ ] Admin: users and roles (list, set role, set studios, activate and deactivate)

### Integrations and AI
- [ ] None. Deliberately.

### Tests and performance
- [ ] RLS matrix covering the six roles across own-studio, other-studio, granted and deleted rows for projects and assets
- [ ] Contract tests for every endpoint above
- [ ] Job idempotency tests (run twice, identical result)
- [ ] Upload resumes after a deliberately dropped connection
- [ ] Grid renders 10,000 seeded assets within the latency budget

### Docs and seed
- [ ] Seed harness generates studios, projects, categories, users and assets with derivatives
- [ ] README section: what Phase 1 added, how to run the demo

**Demo script.** Sign in with a Google account → the grid shows the seeded library → create a project → open the upload wizard, drag in twenty files including one large TIFF, set project and category once for the batch → watch progress, pause and resume one file → the files appear in the grid with thumbnails within seconds → open one and see its metadata → sign in as a viewer from another studio and show that the project and its assets are not visible → show the same query returning nothing in the SQL console under that user's role, proving the rule is in the database.

**Exit criteria.** Upload, browse and access control work end to end; no visibility rule exists only in the interface.

**Risks.** (1) The permission matrix is still proposed — build the policies from the specification and treat changes as policy edits. (2) Drive's listing lag — the ingest path uses parent-scoped reads and the change feed from day one, never a whole-drive search. (3) Large-file decoding — derivatives are generated in the worker, never in a request.

---

## Phase 2 — Metadata and taxonomy

*Brief §9.2: categories, custom fields, hierarchical keywords, bulk edit, project↔asset linking with hero and rank.*

**Goal.** Marketing can shape the vocabulary and apply it at scale, and control how a project presents itself.

**Size:** L.

**Entry gates.** Phase 1 exit criteria met.

### Schema and migrations
- [ ] `dam_keyword_categories`, `dam_keywords`, `dam_keyword_aliases`, `dam_keyword_links`, `dam_category_keyword_categories`
- [ ] `dam_field_categories`, `dam_fields`, `dam_field_options`, `dam_category_fields`, `dam_field_values`
- [ ] Keyword path and depth maintenance trigger; polymorphic link integrity trigger; field value validation trigger
- [ ] Hero uniqueness (partial unique index) and rank re-ranking on `dam_project_assets`
- [ ] Inheritance resolution (`dam_effective_field_values`) and the `reindex_project` job
- [ ] Seed: the default keyword categories in all three namespaces, including the Sector tree

### API
- [ ] Keyword categories and keywords: CRUD, move/reparent, merge, aliases
- [ ] Fields, field options, category field and keyword schemas: CRUD
- [ ] Field values: read and write per asset, project and employee
- [ ] Asset keyword links: add, remove, bulk
- [ ] `POST /api/v2/assets/bulk` for keywords, category, fields and access level
- [ ] Project asset link: set rank, set hero, reorder

### Jobs and workers
- [ ] `reindex_project` after a project, keyword or field change
- [ ] Bulk edit above the inline threshold runs as a job with progress

### UI screens
- [ ] Admin: keyword manager (tree, drag to reparent, merge, rename, aliases)
- [ ] Admin: field manager (definitions, options, per-category required fields)
- [ ] Bulk edit drawer: multi-select, add and remove keywords, set category, set fields, set rights placeholder
- [ ] Project detail: asset ordering, set hero, reorder by drag with a keyboard equivalent
- [ ] Asset detail: keyword and field editing with required-field validation
- [ ] Ratings and favourites
- [ ] Completeness indicator on assets and projects

### Tests and performance
- [ ] Rename a keyword used by 50,000 assets: propagation completes and search stays correct
- [ ] Merge two keyword trees: no links lost, no duplicates created
- [ ] Bulk edit of 5,000 assets within the job budget
- [ ] Required-field enforcement cannot be bypassed through the API
- [ ] Inheritance and override resolve correctly in a table-driven test

### Docs and seed
- [ ] Seed generates keyword trees, custom fields and values with realistic sparsity
- [ ] README section

**Demo script.** Build a keyword tree, drag a branch to a new parent, merge two synonymous keywords and show that assets keep their links → select 500 assets in the grid and apply three keywords and a category in one action → open a project, drag its assets into presentation order, set the hero → show an asset inheriting its project's sector and then overriding it.

**Exit criteria.** The vocabulary is administrable by a non-developer; bulk operations are safe and observable.

**Risks.** Keyword merges are destructive if wrong — every merge writes an audit entry with enough detail to reverse it, and merges are restricted to editor and above.

---

## Phase 3 — Search

*Brief §9.3: full-text, facets, saved searches, lightbox with full metadata.*

**Goal.** Someone can find an asset by describing it, and the result set is fast enough that they keep refining rather than giving up.

**Size:** L.

**Entry gates.** Phase 2 complete. §10.5 answered, because index sizing depends on it.

### Schema and migrations
- [ ] `dam_asset_search` with every column in `SPEC.md` §2.23, maintained by trigger and by `reindex_*` jobs
- [ ] The full index plan: GIN on the tsvector, trigram GIN, GIN on each id array and on the facet JSON, the composite and partial btrees
- [ ] `dam_saved_searches`, `dam_search_log` (partitioned)
- [ ] `dam_search_assets(...)` and the facet-count RPC, both `SECURITY DEFINER`, applying access set-wise

### API
- [ ] `GET /api/v2/assets` with the complete filter grammar, `q`, sorting, keyset pagination and sparse fieldsets
- [ ] Facet counts endpoint
- [ ] Saved searches: CRUD, run, share
- [ ] Zero-result logging

### Jobs and workers
- [ ] Batched reindex covering the whole corpus, restartable
- [ ] Search log retention

### UI screens
- [ ] Search bar with the query grammar (phrases, AND/OR/NOT, field prefixes)
- [ ] Faceted filter rail: project, client, studio, sector, location, category, keyword with AND/OR, photographer placeholder, capture date, orientation, minimum resolution, file type, dominant colour, rights placeholder
- [ ] Results grid with density, infinite scroll, selection and a result count that states whether it is exact or estimated
- [ ] Lightbox: full metadata panel, EXIF, related assets, keyboard navigation
- [ ] Recent searches, saved searches, shareable search URLs
- [ ] Admin: zero-result search report

### Tests and performance
- [ ] The §1 example query returns correct results and is within budget
- [ ] p95 under 500 ms across the 25-query benchmark at the target corpus size, measured and recorded as the baseline
- [ ] Keyset pagination returns every row exactly once across a full enumeration
- [ ] Facet counts agree with the row counts they describe
- [ ] Search respects access control: a user cannot see, in facet counts, evidence of assets they cannot read

### Docs and seed
- [ ] Performance corpus at full scale, with the measurement recorded in the README
- [ ] README section

**Demo script.** Type a natural query into the bar and narrow it with four facets → show the result count and the latency → save the search, share the URL, open it as another user and show the results differ by permission → open the lightbox and walk the metadata → show the zero-result report and one query nobody can satisfy.

**Exit criteria.** The recorded p95 meets the budget on the full corpus, and the number is in the README.

**Risks.** Facet counts are the most expensive part of the page; they are capped, computed in parallel with the rows, and degrade to "many" rather than blocking a result.

---

## Phase 4 — Output

*Brief §9.4: size presets, on-the-fly resize and convert, smart crop, ZIP download, watermarking.*

**Goal.** Nobody downloads a 60 MB TIFF to get a 1200 px JPEG again.

**Size:** L.

**Entry gates.** Phase 3 complete. §10.1 answered, because delivery differs by provider.

### Schema and migrations
- [ ] `dam_sizes`, `dam_aspect_ratios`, `dam_render_cache`
- [ ] Crop overrides stored per asset and aspect ratio
- [ ] Seed: the default size presets and aspect ratios

### API
- [ ] `GET /api/v2/assets/{id}/download` with size preset or explicit dimensions, DPI, format, colour profile, crop, aspect ratio and watermark
- [ ] Sizes and aspect ratios: CRUD
- [ ] `POST /api/v2/exports` for ZIP with a preset, returning a job and then a signed link
- [ ] Contact sheet generation
- [ ] `202` plus poll for a render that is not cached

### Jobs and workers
- [ ] On-demand render job with the params-hash cache
- [ ] `zip_export` with the manifest CSV
- [ ] `transcode_video`, `render_pdf`, and the typed-placeholder path for formats without a converter
- [ ] `purge_render_cache`

### UI screens
- [ ] Download dialog: preset or custom, with a live preview of the result size
- [ ] Smart crop interface: aspect ratio presets, subject-aware suggestion, manual override, saved per asset and ratio
- [ ] Batch download from a selection
- [ ] Contact sheet from a selection
- [ ] Admin: size and aspect ratio management, watermark configuration

### Tests and performance
- [ ] A render derives from the proxy, not the original, whenever the request fits inside it
- [ ] Watermarked and clean renders can never be confused (distinct cache keys)
- [ ] A 500-file ZIP completes within the job budget and the manifest matches the contents
- [ ] The full format matrix produces either a derivative or a typed placeholder, and never an error tile

### Docs and seed
- [ ] README section, including the format matrix as built

**Demo script.** Open a 60 MB TIFF, choose "Web 1200" and download it in under a second → request an unusual size and watch it render once and then return instantly → crop the same image to 16:9 with the suggested subject box, then override it → select forty assets, download as a ZIP at a print preset, open the manifest → show a watermarked download for a viewer and a clean one for an editor.

**Exit criteria.** Every §4.5 output path works from the interface and the API, and the render cache demonstrably prevents repeat work.

---

## Phase 5 — Albums and sharing

*Brief §9.5: albums, external share links with expiry and password, upload requests.*

**Goal.** Work leaves the building safely, and files arrive from outside without an account.

**Size:** M.

**Entry gates.** Phase 4 complete (shares need derivatives and watermarks).

### Schema and migrations
- [ ] `dam_albums`, `dam_album_items`, `dam_album_collaborators`
- [ ] `dam_share_links`, `dam_share_link_items`, `dam_upload_requests`, `dam_upload_request_files`
- [ ] The anonymous-access RPCs (`dam_share_open`, `dam_share_list_items`, `dam_upload_request_open`, `dam_upload_request_finalise`), and no table grants to the anonymous role
- [ ] `dam_comments`, `dam_review_decisions`, `dam_notifications`

### API
- [ ] Albums: CRUD, nesting, item reorder, duplicate, collaborators
- [ ] Share links: create, list, revoke, analytics
- [ ] Public share endpoints: open (with password), list items, download
- [ ] Upload requests: create, list, revoke; public deposit endpoints
- [ ] Comments, review decisions, notifications

### Jobs and workers
- [ ] `send_notification`, `digest_email`
- [ ] Share-link expiry sweep
- [ ] Ingest from an upload request lands in the review queue

### UI screens
- [ ] Album list and album detail with ordering and collaborators
- [ ] Share link manager: options, analytics, revoke
- [ ] The public share page: grid, lightbox, download honouring the share's flags, watermark, password gate
- [ ] Upload request creation and the public deposit page
- [ ] Comments and approval states on assets and albums
- [ ] Notification centre and email digest

### Tests and performance
- [ ] An expired, revoked or wrong-password share returns nothing, and the anonymous role can reach no table directly
- [ ] A share URL copied out of a share does not outlive the share
- [ ] An upload request cannot write outside its project and category
- [ ] Brute-force attempts against a share token are rate-limited and logged

### Docs and seed
- [ ] README section, including the security properties of a share link

**Demo script.** Build an album, reorder it, add a collaborator → create a share link with a password, an expiry and downloads limited to a web preset → open it in a private window, enter the password, download a watermarked image → revoke the link and show the same URL failing → send an upload request to an external address, deposit three files through it, and show them arriving in the review queue against the right project.

**Exit criteria.** External access is possible, bounded, revocable and logged.

**Risks.** This is the largest external attack surface in the product; the phase does not exit until the anonymous-access tests pass, including the negative ones.

---

## Phase 6 — Employee module

*Brief §9.6: profiles, project roles, staff search, resume generation.*

**Goal.** A bid team can answer "who have we got with this credential in this sector" and produce a CV from the answer.

**Size:** M.

**Entry gates.** Phase 3 complete (staff search is search). Phase 4 complete (headshot crops are renders). BambooHR access agreed if employee data is to be imported rather than entered.

### Schema and migrations
- [ ] `dam_employees`, `dam_employee_bios`, `dam_employee_headshots`, `dam_employee_education`, `dam_employee_registrations`, `dam_employee_languages`, `dam_project_employees`
- [ ] The `employee` keyword namespace with Sector Expertise, Typology Expertise and Project Role trees
- [ ] Employee fields folded into the search row so staff search uses the same path as asset search
- [ ] Registration expiry status maintained by a scheduled job

### API
- [ ] Employees: CRUD, plus bios, headshots, education, registrations, languages
- [ ] Project team: add and remove an employee with a role and date range, editable from either side
- [ ] Employee search with credential, sector, studio and years-of-experience filters
- [ ] `POST /api/v2/employees/{id}/resume` returning a generated document

### Jobs and workers
- [ ] Registration expiry sweep with alerts
- [ ] Headshot derivative generation per crop kind

### UI screens
- [ ] Employee directory: headshot grid with filters
- [ ] Employee profile: headshots by kind, bios at each length with approval state, education, registrations with expiry warnings, languages, expertise, project experience
- [ ] Project detail: team tab, editable from the project side
- [ ] One-click CV export choosing a template
- [ ] Org chart view

### Tests and performance
- [ ] The bid-team query ("registration X, sector Y, studio Z, more than N years") returns correct results within budget
- [ ] Editing a project role from either side produces the same row
- [ ] An expired registration is visible as expired without anyone editing it

### Docs and seed
- [ ] Seed generates employees with headshots, bios, registrations and project roles
- [ ] README section

**Demo script.** Open the directory, filter to registered architects in hospitality in one studio with more than ten years of experience → open a profile and show the three bio lengths and the registration expiring next month → add that person to a project with the role "Project Architect" and a date range → export their CV to a template and open the PDF.

**Exit criteria.** The §1 example query's employee clause is answerable from the interface.

---

## Phase 7 — Document generation

*Brief §9.7: template engine, merge fields, project sheets and qualification packages.*

**Goal.** The documents marketing rebuilds by hand every week come out of the system with live data.

**Size:** L.

**Entry gates.** Phases 4 and 6 complete. Text blocks needed by templates are in place.

### Schema and migrations
- [ ] `dam_text_blocks`, `dam_text_block_versions`, `dam_templates`, `dam_template_versions`, `dam_generated_documents`
- [ ] Generated documents reference an approved text-block **version**, never a live body

### API
- [ ] Text blocks: CRUD, versions, submit, approve
- [ ] Templates: CRUD, versions, brand lock
- [ ] `POST /api/v2/documents/generate` with inputs and format; get, download
- [ ] Merge-field manifest exposed so the generator UI can validate inputs

### Jobs and workers
- [ ] `generate_document` for PDF, DOCX and PPTX
- [ ] Image placement at the correct size preset inside generated documents

### UI screens
- [ ] Template gallery with versions and brand-lock state
- [ ] Document generator: pick a template, pick the project or employee, preview, generate, download
- [ ] Project detail: text tab (descriptions at each length with approval) and documents tab
- [ ] Admin: template management

### Integrations and AI
- [ ] Office add-in (task pane): search the library, place an asset at the correct size into PowerPoint or Word
- [ ] InDesign plugin, or the documented fallback if the platform work is deferred

### Tests and performance
- [ ] A generated project sheet contains only approved text-block versions
- [ ] Brand-locked regions cannot be altered by a template edit below the required role
- [ ] Regenerating the same document with the same inputs produces the same output

### Docs and seed
- [ ] Seed includes templates for a project sheet, a CV and a qualification pack
- [ ] README section

**Demo script.** Generate a project sheet for a completed project as a PDF and as a PowerPoint slide → change the project's 150-word description, approve it, regenerate, show the update → build a three-project qualification package with two CVs → open PowerPoint, search the library in the task pane, place a hero image at the presentation preset.

**Exit criteria.** Each document type in brief §4.5 is produced from live data by a non-developer.

---

## Phase 8 — Rights and governance

*Brief §9.8: DRM fields, badges, expiry alerts, audit log, analytics dashboard.*

**Goal.** The firm can tell, per asset, what it is allowed to do — and prove afterwards what it did.

**Size:** L.

**Entry gates.** Phases 4 and 5 complete (rights gate downloads and shares). §10.3 answered, because the matrix decides who may override.

### Schema and migrations
- [ ] `dam_photographers`, `dam_copyright_holders`, `dam_copyright_policies`, `dam_asset_rights`
- [ ] Rights status materialised into the search row; nightly sweep because time moves status
- [ ] `dam_retention_policies`, `dam_tiering_rules`
- [ ] Analytics materialised views over usage, search and audit

### API
- [ ] Photographers, copyright holders and policies: CRUD
- [ ] Asset rights: read and write, bulk apply a policy
- [ ] Audit log and usage events: read with filters
- [ ] Analytics aggregates: most viewed and downloaded, top searches, zero-result searches, storage by studio, category and tier, ingest volume, completeness, dormant assets
- [ ] Retention and tiering rules: CRUD

### Jobs and workers
- [ ] `rights_sweep` with alerts at 90, 30 and 7 days
- [ ] `tiering_sweep`, `restore_from_archive`, `purge_trash`
- [ ] Nightly refresh of the analytics views

### UI screens
- [ ] Rights badges in the grid and the lightbox
- [ ] Rights dashboard: expiring, expired, restricted, unknown, with bulk actions
- [ ] Download gate: blocked with a reason, or a warning that records an acknowledgement, per role
- [ ] Admin: audit log viewer with diffs; analytics dashboard; retention, trash and storage tiering
- [ ] Trash with restore

### Tests and performance
- [ ] A restricted asset cannot be downloaded by a role that lacks the override, through any route including the v1 shim and a share link
- [ ] An override is recorded with actor, reason and timestamp
- [ ] Status changes with the passage of time without an edit
- [ ] Deleted rows are invisible except through the trash, to the roles permitted to see it

### Docs and seed
- [ ] Seed includes policies, photographers and a spread of rights states
- [ ] README section

**Demo script.** Show the four rights badges in one grid → attempt a restricted download as a viewer and be blocked; repeat as an editor, acknowledge the warning, then show the acknowledgement in the usage log → move the clock and show an asset becoming "expiring" and its owner receiving an alert → open the audit log and show the full before-and-after of a metadata change → walk the analytics dashboard → delete an asset and restore it from the trash.

**Exit criteria.** Rights are enforced in the database, not the interface, and every enforcement decision is auditable.

---

## Phase 9 — Integrations

*Brief §9.9: REST API, webhooks, HubSpot / BambooHR / ProjectWorks connectors, sync UI, migration importer.*

**Goal.** The DAM stops being an island: master data flows in, events flow out, and the existing library moves in without loss.

**Size:** XL.

**Entry gates.** Phases 1 to 8 complete. §10.4 answered (importer scope). Q8 answered or the shim kept indefinitely. Credentials for each connector agreed.

### Schema and migrations
- [ ] `dam_webhooks`, `dam_webhook_deliveries`
- [ ] `dam_integrations`, `dam_integration_field_mappings`, `dam_sync_runs`, `dam_sync_conflicts`
- [ ] External id coverage for every synced entity

### API
- [ ] The v2 surface completed for every remaining entity, with sparse fieldsets, includes, filters, bulk endpoints and rate limits documented
- [ ] Webhooks: subscriptions, deliveries, test, replay; HMAC signing
- [ ] Integrations: CRUD, field mappings, run, runs, conflicts and resolution
- [ ] The `/api/v1` compatibility shim serving the four consumer sites from the new model, with the frozen 16-endpoint contract

### Jobs and workers
- [ ] `sync_run` per connector: HubSpot, BambooHR, ProjectWorks, Google Drive and Sheets, Marq, CSV
- [ ] `webhook_deliver` with retries and dead-lettering
- [ ] The OpenAsset importer: resumable, throttled, idempotent on external ids, with a dry-run report
- [ ] The existing-library importer, conditional on §10.4, following `SPEC.md` §6.17

### UI screens
- [ ] Admin: integrations list, field-mapping editor with a source-of-truth column, schedule, conflict policy
- [ ] Admin: sync run history with counts and an error log; conflict queue with resolution
- [ ] Admin: API keys (create, show once, rotate, revoke) and webhook management
- [ ] Import wizard for CSV and for an OpenAsset export, with the dry-run report

### Tests and performance
- [ ] Every v1 endpoint replayed against the shim, field by field, using recorded traffic from the four sites
- [ ] A sync run interrupted mid-way resumes without duplicating or skipping
- [ ] Conflicting edits land in the conflict queue rather than overwriting silently
- [ ] The importer is idempotent: running it twice changes nothing the second time
- [ ] Webhook signatures verify, and a failing endpoint dead-letters rather than retrying forever

### Docs and seed
- [ ] Consumer migration guide for the four sites, including what changes and what does not
- [ ] README section

**Demo script.** Run a ProjectWorks sync and show projects appearing with codes, clients and status, and the source-of-truth column preventing the DAM from overwriting them → run a BambooHR sync and show employees and headshots arriving → edit a field the connector owns and show the conflict queue catching it → subscribe a webhook, upload an asset, show the signed delivery → point one consumer site at the shim and show its pages still working → run the OpenAsset importer in dry-run and read the report.

**Exit criteria.** The four existing consumer sites work against the new system, and at least one connector is running on a schedule in staging.

**Risks.** The shim is the highest-risk deliverable in the project: it is tested against recorded real traffic, and no consumer site is switched over until its replay is field-for-field identical.

---

## Phase 10 — AI layer

*Brief §9.10: auto-tagging, embeddings, semantic and similarity search, OCR, description generation, conversational query.*

**Goal.** The library describes itself, and a person can ask it a question in their own words.

**Size:** L.

**Entry gates.** Phase 3 exit criteria met and recorded — **the AI layer does not start before search works properly** (brief §9). Q9 answered, because the vector dimension is fixed before any embedding is written.

### Schema and migrations
- [ ] `dam_asset_embeddings` with HNSW indexes, `dam_asset_ocr_text`, `dam_ai_suggestions`, `dam_ai_runs`
- [ ] Hybrid ranking in the search RPC (rank fusion of text and vector)

### API
- [ ] Suggestions: list, accept, reject, bulk accept
- [ ] Trigger auto-tag, caption and describe
- [ ] Semantic search parameters on the asset search endpoint; `GET /api/v2/assets/{id}/similar`
- [ ] Conversational query endpoint returning text with citations and performing no writes
- [ ] AI run records for cost reporting

### Jobs and workers
- [ ] `ai_autotag`, `ai_caption`, `ai_describe`
- [ ] `embed` and `ocr` in the ingest chain, plus batched backfills over the existing corpus
- [ ] Headshot matching producing suggestions, never links

### UI screens
- [ ] Suggestion review: per asset and in bulk, with confidence shown and a threshold control
- [ ] "Find more like this" from any asset
- [ ] Natural-language search with an indication of when semantic matching contributed
- [ ] Project description drafting into a draft text-block version
- [ ] Conversational query surface with citations
- [ ] Admin: AI cost and usage reporting

### Tests and performance
- [ ] No AI output reaches a live column without a human acceptance, verified by a test that attempts it
- [ ] Semantic search stays within the latency budget alongside the existing indexes
- [ ] A backfill can be stopped and resumed
- [ ] A provider outage degrades the feature without failing search or ingest
- [ ] Cost per operation is recorded and visible

### Docs and seed
- [ ] README section, including the model and dimension in use and the cost of a full backfill

**Demo script.** Upload ten images and show suggested keywords and captions awaiting review; accept some, reject others → search "warm timber lobby at dusk" and get sensible results → "find more like this" from a hero image → draft a 150-word project description from metadata and approved text blocks, edit and approve it → ask "which completed food and beverage projects do we have photography for in Dubai" and get an answer with citations → open the cost report.

**Exit criteria.** Every AI feature writes suggestions rather than facts, and search quality is measurably better with the layer than without it.

---

## Phase 11 — RFP and proposal AI (conditional)

**Only if OPEN §10.2 decides to build it inside the DAM.** If it is a separate application, this phase does not exist and the DAM's contribution is the v2 API, text blocks, approved imagery and the conversational query built in Phase 10.

**Size:** XL.

- [ ] Decision recorded in `SPEC.md` §1.11
- [ ] Tables for parsed documents, extracted requirements and drafted responses (not in the canonical inventory; they would be added)
- [ ] Tender document parsing and requirement extraction
- [ ] Compliance checklist against extracted requirements
- [ ] Go / no-go scoring with the inputs recorded
- [ ] Assisted drafting pulling approved text blocks and imagery, never inventing credentials
- [ ] Every generated claim traceable to an approved source

---

## Cross-cutting checklists

These are not a phase. Each item is checked in **every** phase that touches it, and audited at the end of Phases 3, 8 and 10.

**Security**
- [ ] RLS enabled with a policy on every new table, and the RLS matrix extended to cover it
- [ ] No new route trusts a client-supplied identity header
- [ ] Every new secret is in Secret Manager and named, never valued, in configuration
- [ ] Every new external surface is rate-limited and logged

**Accessibility (WCAG 2.1 AA)**
- [ ] Contrast asserted in CI for both light and dark
- [ ] Every new interaction has a keyboard path; no drag-only actions
- [ ] Automated accessibility pass plus a manual keyboard walkthrough of the phase's screens

**Observability**
- [ ] New failure modes produce structured logs with a request id
- [ ] New long-running work reports progress and appears in the job views
- [ ] New SLO-relevant metrics added to the dashboard

**Backups and restore**
- [ ] New storage buckets included in the backup policy
- [ ] Restore drill repeated after any change to the storage layout

**Performance**
- [ ] The benchmark suite extended with the phase's new query shapes
- [ ] p95 re-measured and recorded; a regression over 20% blocks the phase

**Migration (conditional on §10.4)**
- [ ] The mapping in `SPEC.md` §6.17 re-validated whenever a target column changes
- [ ] Legacy ids preserved for anything the four consumer sites can address

---

## Traceability — brief §4 and §5 to phases

| Brief requirement | Phase |
|---|---|
| §4.1 Drag-and-drop and bulk upload, progress, pause and resume, chunked | 1 |
| §4.1 Folder-structure ingest, project-code mapping | 9 (importer), 2 (rules) |
| §4.1 Watched folder and scheduled ingest | 9 |
| §4.1 Metadata at point of upload | 1 (project, category), 2 (keywords, fields), 8 (rights) |
| §4.1 EXIF, IPTC, XMP extraction | 1 |
| §4.1 Filename intelligence; headshot matching | 2 (project codes), 10 (headshots) |
| §4.1 Duplicate detection, hash and perceptual | 1 (hashes), 4 (resolution UI) |
| §4.1 Derivatives: thumbnail, preview, proxy, video, PDF, CAD placeholder | 1 (images), 4 (the rest) |
| §4.1 Versioning | 1 (schema), 4 (replace and history UI) |
| §4.1 Review queue | 1 (states), 5 (approval UI) |
| §4.1 Twenty minimum formats | 4 |
| §4.2 Inheritance and override | 2 |
| §4.2 Keyword trees, reparent, merge, rename, synonyms | 2 |
| §4.2 Bulk edit | 2 |
| §4.2 Hero and rank | 2 |
| §4.2 Ratings and favourites | 2 |
| §4.2 Controlled vocabularies, required fields | 2 |
| §4.2 Completeness scoring | 2 (score), 8 (reporting) |
| §4.3 Full-text search | 3 |
| §4.3 Faceted filtering | 3 |
| §4.3 Boolean and phrase | 3 |
| §4.3 Semantic search | 10 |
| §4.3 Visual similarity | 10 |
| §4.3 OCR | 10 |
| §4.3 Map view | 3 |
| §4.3 Saved, recent, shareable searches | 3 |
| §4.3 Grid, infinite scroll, lightbox | 1 (grid), 3 (lightbox) |
| §4.3 Zero-result logging | 3 |
| §4.4 Albums | 5 |
| §4.4 External share links | 5 |
| §4.4 Upload requests | 5 |
| §4.4 Comments and approvals | 5 |
| §4.4 Notifications and digests | 5 |
| §4.4 Activity feed | 8 |
| §4.5 On-the-fly derivatives at download | 4 |
| §4.5 Smart cropping | 4 |
| §4.5 Watermarking | 4 |
| §4.5 ZIP with manifest | 4 |
| §4.5 Contact sheets | 4 |
| §4.5 Template-driven documents, project sheets, CVs, packages, decks | 7 (CVs also 6) |
| §4.5 Template library, versioning, brand lock | 7 |
| §4.5 Office and InDesign add-ins | 7 |
| §4.6 Employee directory and profiles | 6 |
| §4.6 Project experience | 6 |
| §4.6 Staff search | 6 |
| §4.6 Resume export | 6 |
| §4.6 Org chart | 6 |
| §4.7 Rights fields | 8 |
| §4.7 Badges | 8 |
| §4.7 Block or warn on download | 8 |
| §4.7 Expiry alerting | 8 |
| §4.7 Usage log | 8 |
| §4.8 Roles and groups | 1 |
| §4.8 Access levels enforced in RLS | 1 |
| §4.8 SSO, SAML/OIDC fallback, SCIM note | 1 |
| §4.8 Audit log | 1 (capture), 8 (viewer) |
| §4.8 Analytics dashboard | 8 |
| §4.8 Admin UIs for fields, keywords, categories, sizes, templates | 2, 4, 7 |
| §4.8 Storage tiering and restore | 8 |
| §4.8 Retention and trash | 8 |
| §4.8 Multi-studio scoping | 1 |
| §4.9 REST API | 1 onwards; completed in 9 |
| §4.9 Webhooks | 9 |
| §4.9 Connectors | 9 |
| §4.9 Sync configuration UI | 9 |
| §4.9 Migration tooling | 9 |
| §4.10 Auto-tagging as suggestions | 10 |
| §4.10 Captions and alt text | 10 |
| §4.10 Embeddings | 10 |
| §4.10 OCR | 10 |
| §4.10 Headshot matching | 10 |
| §4.10 Description drafting | 10 |
| §4.10 Conversational query | 10 |
| §4.10 RFP parsing (stretch) | 11, conditional |
| §4.11 Tablet and mobile capture | 1 (shell), 5 (capture flow) |
| §4.11 Search under 500 ms at 500,000 assets | 3 |
| §4.11 CDN and signed URLs | 4 |
| §4.11 WCAG 2.1 AA | every phase |
| §4.11 Logging, error tracking, health, status page | 0 |
| §4.11 Backups and restore procedure | 0, drilled quarterly |
| §4.11 Seed script at scale | 0 (skeleton), 3 (full corpus) |
| §5 Dashboard | 8 |
| §5 Search and browse grid | 1, 3 |
| §5 Asset detail | 3 |
| §5 Project list and detail | 1, 2, 6, 7 |
| §5 Employee directory and profile | 6 |
| §5 Album list and detail | 5 |
| §5 Upload wizard | 1 |
| §5 Bulk edit drawer | 2 |
| §5 Share link manager | 5 |
| §5 Template gallery and document generator | 7 |
| §5 Rights dashboard | 8 |
| §5 Admin screens | 1, 2, 4, 7, 8, 9 |

Nothing in `SPEC.md` is unscheduled. Two items are scheduled conditionally: the existing-library importer (Phase 9, conditional on §10.4) and the RFP module (Phase 11, conditional on §10.2).

---

## Dependencies — what must not be built before what

- **Search (3) before the AI layer (10).** The brief states it; the reason is that semantic ranking is only measurable against a working text and facet baseline.
- **Output (4) before sharing (5).** A share link needs derivatives, size presets and watermarking; building sharing first means building it twice.
- **Output (4) and employees (6) before document generation (7).** Documents place sized images and employee data.
- **Rights (8) after output (4) and sharing (5).** The gate has to sit in front of every download path, and those phases create the paths.
- **Search (3) before staff search (6).** Staff search reuses the search infrastructure rather than a parallel one.
- **Everything before integrations (9).** The shim maps the *finished* model onto the v1 contract; mapping a half-built model produces a shim that has to be rewritten.
- **Phase 0 decisions before the vector dimension is fixed.** Changing the embedding model after data exists means re-embedding the entire corpus.
- **The permission matrix before Phase 8**, and preferably before Phase 1, because policies are cheaper to write once than to rewrite across sixty tables.

