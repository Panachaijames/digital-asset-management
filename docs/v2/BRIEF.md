# Build Prompt — Project-Based DAM for an AEC Firm (OpenAsset-equivalent)

> Verbatim copy of the user's brief (2026-09-08). Section numbers are referenced by every agent prompt.

---

## 0. Instructions to you, the agent

Do **not** start writing application code on the first pass. Work in this order:

1. Read this brief in full and produce a `SPEC.md` restating scope, data model and API surface.
2. Produce `SCHEMA.sql` (Postgres) with tables, enums, indexes and RLS policies.
3. Produce `ROADMAP.md` breaking the build into the phases in §9, with a checklist per phase.
4. Stop and let me review those three files before scaffolding the app.

Ask me before inventing anything in the "Open decisions" list in §10. Everywhere else, pick a sensible default and record it in `SPEC.md`.

---

## 1. What I am building

A **project-based digital asset management platform** for a multi-studio international architecture and interior design firm. Functionally equivalent to OpenAsset (by Axomic), which is the incumbent product in this niche.

The defining characteristic — and the thing that separates this from a generic DAM like Bynder, Canto or Brandfolder — is that **the project, not the folder, is the primary organizing unit**. Assets hang off projects. Metadata is inherited from the project down to the asset. Employees are first-class records linked to the projects they worked on. Search is expected to answer questions like "show me hero images of completed hospitality projects in Vietnam over 4,000 sqm where Somchai was project architect."

Primary users: marketing and bid/proposal teams. Secondary: design leads, studio directors, BD.

---

## 2. Tech stack (fixed unless I say otherwise)

- **Frontend:** Next.js 15 (App Router), TypeScript, Tailwind CSS, React Server Components where sensible.
- **Database + auth:** Supabase (Postgres, Row Level Security, Storage for derivatives, `pgvector` for embeddings, `pg_trgm` + GIN for text search).
- **Primary file storage:** Google Drive (shared drives, service-account access) — treat Drive as the object store and Postgres as the index. Abstract this behind a `StorageProvider` interface so S3/GCS can be swapped in later.
- **Deployment:** Google Cloud Run, region `asia-southeast-3`. Containerised, stateless.
- **Auth:** Google SSO (Workspace) with a 6-tier role hierarchy.
- **Background jobs:** queue-based workers for ingest, thumbnailing, transcode, embedding, sync. No long work in request handlers.
- **AI:** pluggable provider interface. Gemini and Anthropic Claude both behind one adapter.
- **Design system:** paper white, ink black, blueprint blue. Fraunces (display), Montserrat (UI), JetBrains Mono (code/metadata). Dense, information-first layouts — this is a professional tool, not a consumer gallery.

---

## 3. Core object model

Build these as first-class entities. Names in parentheses are the equivalent OpenAsset REST resources, given so you can sanity-check completeness.

| Entity | Purpose |
|---|---|
| **Project** (`Projects`) | The spine. Project code, name, client, studio, location + geocoordinates, sector/typology, size, value, status, start/completion dates, hero asset, custom fields. |
| **Asset / File** (`Files`) | Any digital file, always linkable to zero or more projects. Images, renderings, video, PDF, CAD, InDesign, Office docs. |
| **Category** (`Categories`) | Top-level bucket for assets: Project Photography, Renderings, Drawings, Staff, Logos & Brand, Marketing Collateral, Awards, Site Photos. Each category has its own field and keyword schema. |
| **Keyword** (`Keywords`, `ProjectKeywords`) | Hierarchical tags. Separate namespaces for asset keywords and project keywords. |
| **Keyword Category** (`KeywordCategories`, `ProjectKeywordCategories`) | Groups keyword trees, e.g. Space Type, Material, Time of Day, Photography Style, Sector. |
| **Field** (`Fields`) | Admin-definable custom metadata field. Types: text, long text, number, date, single-select, multi-select, boolean, URL, currency. Scoped to project / asset / employee. Grouped into field categories. |
| **Employee** (`Employees`) | Staff record: headshot(s), bio in multiple lengths (25/50/150 words), qualifications, registrations and licences, years of experience, sector expertise, project roles with dates. |
| **Album** (`Albums`) | Curated collection of assets. Personal, shared, or company-wide. Ordered. Shareable. |
| **Text Block** (`TextRewrites`) | Reusable approved copy: project descriptions at several lengths, boilerplate, awards text, sustainability narratives. Versioned, with approval state. |
| **Photographer** (`Photographers`) | Credit record, linked to assets. |
| **Copyright Holder / Policy** (`CopyrightHolders`, `CopyrightPolicies`) | Rights holder plus reusable licence terms. |
| **Size** (`Sizes`) | Named output presets — dimensions, DPI, format, colour profile, watermark on/off. |
| **Aspect Ratio** (`AspectRatios`) | Named crop ratios for smart cropping. |
| **Saved Search** (`Searches`) | Persisted query with filters, shareable. |
| **User / Group / Access Level** (`Users`, `Groups`, `AccessLevel`) | Identity and permission primitives. |
| **Storage Location** (`AlternateStores`) | Hot/cold/archive tiers. |

Relationships that matter: project ↔ asset is many-to-many with a per-link `rank` and `is_hero` flag. Employee ↔ project is many-to-many with `role` and date range. Everything taggable is taggable via a polymorphic keyword join.

---

## 4. Functional modules

### 4.1 Ingest & upload
- Drag-and-drop and bulk uploader with per-file progress, pause/resume, and chunked upload for large files.
- Folder-structure ingest: walk a Drive folder tree and map folder names to project codes.
- Watched-folder / scheduled ingest from a Drive location.
- **Metadata at point of upload:** apply project, category, keywords, fields and rights to the whole batch before commit.
- Auto-extract EXIF, IPTC, XMP on ingest — capture date, camera, lens, GPS, embedded copyright and caption.
- **Filename intelligence:** parse project codes out of filenames to auto-suggest the project; match staff headshot filenames against employee names/IDs to auto-suggest the employee link.
- Duplicate detection by content hash plus perceptual hash for near-duplicates. Offer merge/skip/replace.
- Derivative generation: thumbnail, web preview, high-res proxy. Video poster frame plus transcode to MP4/H.264. PDF first-page render. CAD/Revit preview if feasible, otherwise a typed placeholder.
- File versioning — replace an asset while keeping history, metadata and album membership intact.
- Optional review queue: uploads land as `pending` and require approval before becoming visible.
- Formats to handle at minimum: JPG, PNG, TIFF, WEBP, HEIC, RAW (CR2/NEF/ARW), PSD, AI, INDD, SVG, PDF, DWG, DXF, RVT, SKP, MP4, MOV, DOCX, PPTX, XLSX.

### 4.2 Organisation & metadata
- Project-level metadata cascades to linked assets; asset-level values override.
- Hierarchical keyword trees with drag-to-reparent, merge, rename-with-propagation, and synonyms/aliases.
- Bulk edit: multi-select any number of assets and apply/remove keywords, change category, set rights, edit fields.
- Hero image per project, plus manual `rank` ordering so marketing controls the presentation sequence.
- Star ratings and personal favourites.
- Controlled vocabularies with validation, required-field enforcement per category.
- Metadata completeness scoring — surface assets and projects that are under-tagged.

### 4.3 Search & discovery
- Single search bar doing full-text across filename, caption, keywords, project name/code, text blocks, employee names.
- **Faceted filtering:** project, client, studio, sector, location, category, keyword (multi-select AND/OR), photographer, capture date range, orientation, min resolution, file type, dominant colour, rights status.
- Boolean operators and phrase matching.
- **Semantic / vector search** over image embeddings and captions — natural-language queries like "warm timber lobby at dusk".
- **Visual similarity:** "find more like this" from any asset.
- OCR text extraction from images and PDFs, indexed and searchable.
- Map view: projects plotted by geocoordinates, filterable, click through to assets.
- Saved searches, recent searches, and shareable search URLs.
- Results grid with adjustable density, infinite scroll, and a lightbox with full metadata panel, EXIF, rights status, usage history and related assets.
- Zero-result search logging so admins can see what people look for and fail to find.

### 4.4 Collaboration & sharing
- Albums: create, reorder, nest, duplicate, add collaborators.
- **External share links:** scoped to an album or selection, with optional expiry date, password, download on/off, watermark on/off, and view analytics.
- Upload requests — send a link to an external photographer so they can deposit files straight into a project without an account.
- Comments and approval states on assets and albums.
- Notifications: in-app plus email digest for shares, approvals, expiring rights, ingest completion.
- Activity feed per project, per asset, per user.

### 4.5 Output & document creation
This is where AEC DAMs earn their keep — do not treat it as an afterthought.
- **On-the-fly derivative generation at download:** pick a named Size preset, or set custom dimensions, DPI, format and colour profile. Never make the user download a 60 MB TIFF to get a 1200 px JPG.
- Smart cropping to a chosen aspect ratio, with subject-aware crop suggestion and manual override.
- Watermarking, configurable per access level and per share.
- Batch download as ZIP with a chosen preset and a manifest CSV.
- Contact sheets / PDF proof sheets from a selection.
- **Template-driven document generation** with merge fields pulling live project, asset, employee and text-block data:
  - Project sheets / cut sheets (PDF, DOCX, PPTX).
  - **Employee resumes and CVs** — headshot, bio, credentials, selected project experience, auto-laid-out.
  - Award submission and RFP qualification packages.
  - Credentials / portfolio decks.
- Template library with versioning and brand locking.
- Office and InDesign side-panel plugins, or at minimum an add-in that lets a user search the DAM and place a correctly sized asset directly into PPTX/DOCX/INDD.

### 4.6 Employee module
- Searchable, visual staff directory with headshot grid.
- Profile: multiple headshot crops (formal, casual, B&W), bios at several lengths, education, professional registrations with expiry tracking, languages, sector and typology expertise.
- Project experience table with role and date range, editable from either the employee or the project side.
- Search staff by credential, sector experience, studio, or years of experience — the query a bid team actually runs.
- One-click resume export to a chosen template.
- Optional org chart view.

### 4.7 Rights & DRM
- Per-asset: photographer, copyright holder, licence/policy, permitted uses, territory, embargo date, expiry date, model-release status.
- Visual rights badges in the grid — cleared / restricted / expiring / expired.
- Hard block or warn-and-log on download of restricted assets, configurable per role.
- Expiry alerting to asset owners and admins ahead of the date.
- Usage log per asset — who downloaded what, when, and (where declared) for which purpose.

### 4.8 Admin & governance
- Users, groups, and a **6-tier role hierarchy** — suggest: Viewer, Contributor, Editor, Studio Admin, Global Admin, Owner. Define the exact permission matrix in `SPEC.md`.
- Access levels applied at category, project and individual asset granularity, enforced in Postgres RLS, not only in the UI.
- Google SSO plus SAML/OIDC fallback; SCIM user provisioning if cheap to add.
- Full audit log of every create/update/delete/download/share with actor, timestamp and diff.
- **Analytics dashboard:** most-viewed and most-downloaded assets, top search terms, zero-result searches, storage by studio/category/tier, ingest volume over time, tagging completeness, dormant assets.
- Field, keyword, category, size and template administration UIs.
- Storage tiering with rules to move cold assets to archive; restore-on-demand.
- Retention policies and soft delete with a recoverable trash for N days.
- Multi-studio scoping — each studio sees its own work by default, with cross-studio visibility as a permission.

### 4.9 Integrations & API
- **REST API** covering every entity, with token auth, pagination, sparse fieldsets, nested-resource expansion (e.g. `/projects/18?include=assets`), and rate limiting. Model the ergonomics on OpenAsset's own API so migration scripts are easy to write.
- Webhooks on asset created/updated, project created/updated, share viewed, rights expiring.
- Connectors to build: **HubSpot** (projects ↔ deals/companies), **BambooHR** (employee master data and headshots), **ProjectWorks** (project master data, codes, status), **Google Drive/Sheets**, **Marq**, and a generic CSV import/export.
- A sync configuration UI: field mapping, direction, schedule, conflict policy, last-run status and error log. Treat one external system as the source of truth per field and make that explicit.
- Bulk migration tooling: importer that can ingest an existing OpenAsset export (projects, files, keywords, employees, albums) without data loss.

### 4.10 AI layer
- Auto-tagging from a vision model, writing into a *suggested* keyword state that a human confirms — never silently into the live taxonomy.
- Caption and alt-text generation.
- Image embeddings in `pgvector` for semantic and similarity search.
- OCR on images and PDFs.
- Headshot matching to employee records.
- Draft project description generation from project metadata plus existing text blocks, in the firm's voice, at the requested length.
- Conversational query over the asset and project corpus ("which completed F&B projects do we have photography for in Dubai?").
- *Stretch, mirroring OpenAsset's "Shred" product:* RFP/tender document parsing, requirement extraction, compliance checklist, go/no-go scoring, and assisted proposal drafting that pulls approved text blocks and imagery.

### 4.11 Non-functional requirements
- Responsive down to tablet; a genuinely usable mobile view for site photo capture and upload.
- Search results under 500 ms p95 on a 500,000-asset corpus. Design the indexes for that from the start.
- CDN-fronted derivative delivery with signed URLs.
- WCAG 2.1 AA.
- Structured logging, error tracking, health endpoint, and a status page.
- Automated backups with a documented restore procedure.
- Seed script generating realistic fake data at scale for performance testing.

---

## 5. Screens to build

Dashboard · Search / browse grid · Asset detail (lightbox + metadata) · Project list · Project detail (overview, assets, team, text, documents) · Employee directory · Employee profile · Album list · Album detail · Upload / ingest wizard · Bulk edit drawer · Share link manager · Template gallery · Document generator · Rights dashboard · Admin: users & roles, fields, keywords, categories, sizes, templates, integrations, sync logs, audit log, analytics, storage.

---

## 6. Conventions

- All tables prefixed `dam_`.
- `snake_case` in Postgres, `camelCase` in TypeScript, with a generated types layer between them.
- Every table: `id` (uuid), `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` (soft delete).
- RLS on every table. Deny by default.
- Zod schemas as the single source of truth for validation, shared between API and client.
- No secrets in the repo. Everything through environment variables.

---

## 7. Deliverables per phase

Working code, migration files, seed data, API docs (OpenAPI), and a short `README` section explaining what the phase added and how to test it.

---

## 8. Explicit non-goals

Not building: a design/CAD editor, a full DMS for contract documents, time tracking, invoicing, a public marketing website, or a mobile native app in v1.

---

## 9. Build order

1. **Foundation** — auth, SSO, roles, RLS, project and asset schema, Drive storage adapter, basic upload, thumbnails, grid browse.
2. **Metadata & taxonomy** — categories, custom fields, hierarchical keywords, bulk edit, project↔asset linking with hero and rank.
3. **Search** — full-text, facets, saved searches, lightbox with full metadata.
4. **Output** — Size presets, on-the-fly resize/convert, smart crop, ZIP download, watermarking.
5. **Albums & sharing** — albums, external share links with expiry/password, upload requests.
6. **Employee module** — profiles, project roles, staff search, resume generation.
7. **Document generation** — template engine, merge fields, project sheets and qualification packages.
8. **Rights & governance** — DRM fields, badges, expiry alerts, audit log, analytics dashboard.
9. **Integrations** — REST API, webhooks, HubSpot / BambooHR / ProjectWorks connectors, sync UI, migration importer.
10. **AI layer** — auto-tagging, embeddings, semantic and similarity search, OCR, description generation, conversational query.

Ship each phase as something demonstrable. Do not build the AI layer before search works properly.

---

## 10. Open decisions — ask me

1. Google Drive as the durable store versus Supabase Storage or GCS. Drive is cheap and already licensed but has quota and throughput limits at scale.
2. Whether to build the RFP/proposal-AI module at all, or keep this DAM-only and treat proposals as a separate application.
3. Exact 6-tier permission matrix.
4. Whether the existing internal DAM (`dam_assets` table, Drive storage) is migrated into this, or this is a clean rebuild that replaces it.
5. Target scale — number of assets, projects, employees, concurrent users at go-live and in three years.
