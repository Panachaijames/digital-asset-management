import type { Metadata } from "next";
import EmbedGallery, { type EmbedConfig } from "@/components/EmbedGallery";

// Not AppShell: this page is the whole point of having a chrome-free route.
// It stays directly under the root layout, like /login, because a route-group
// layout that re-declared <html>/<body> would drop the pre-paint theme script
// and render the gallery with no theme class at all.
//
// Who may frame it is decided in middleware.ts from DAM_EMBED_ORIGINS; who may
// SEE it is the ordinary session gate. An unauthenticated request reaches this
// page (middleware deliberately does not redirect /embed to /login), and the
// client renders its own sign-in card — there is no data in this file.

export const metadata: Metadata = {
  title: "Digital Assets",
  // An embed URL in someone's CMS should never become a search result.
  robots: { index: false, follow: false },
};

// The query string is the entire page and the session decides what renders,
// so there is nothing here worth prerendering or caching.
export const dynamic = "force-dynamic";

type RawParams = Record<string, string | string[] | undefined>;

// A repeated parameter (?columns=2&columns=3) arrives as an array. Take the
// first and move on rather than failing the page over it.
function one(params: RawParams, key: string): string | undefined {
  const value = params[key];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

// Filters passed straight through to GET /api/assets. Anything not on this list
// is ignored: the embed URL is written by whoever owns the host page, so the
// surface it can reach is a fixed allowlist, not "whatever the route accepts".
const FILTER_PARAMS = [
  "path",
  "pathPrefix",
  "tags",
  "q",
  "macro",
  "core",
  "sub",
  "studio",
  "permission",
  "sort",
] as const;

const COLUMNS = ["auto", "1", "2", "3", "4", "6"] as const;

export default async function EmbedPage(props: {
  searchParams?: Promise<RawParams>;
}) {
  const params = (await props.searchParams) ?? {};

  const query: Record<string, string> = {};
  for (const key of FILTER_PARAMS) {
    const value = one(params, key);
    if (value !== undefined) query[key] = value;
  }

  const columnsParam = one(params, "columns");
  const columns = (COLUMNS as readonly string[]).includes(columnsParam ?? "")
    ? (columnsParam as EmbedConfig["columns"])
    : "auto";

  // controls=none turns the lot off; otherwise it is a comma-separated pick
  // from search, tags and sort. Absent means the default pair.
  const controlsParam = one(params, "controls");
  const wanted =
    controlsParam === undefined
      ? ["search", "tags"]
      : controlsParam === "none"
      ? []
      : controlsParam.split(",").map((c) => c.trim().toLowerCase());

  const openParam = one(params, "open");
  const open: EmbedConfig["open"] =
    openParam === "tab" || openParam === "none" ? openParam : "lightbox";

  const pageSizeRaw = Number(one(params, "limit") ?? 60);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(200, Math.max(1, Math.floor(pageSizeRaw)))
    : 60;

  const config: EmbedConfig = {
    query,
    controls: {
      search: wanted.includes("search"),
      tags: wanted.includes("tags"),
      sort: wanted.includes("sort"),
    },
    columns,
    title: one(params, "title") ?? null,
    description: one(params, "description") ?? null,
    open,
    autoHeight: one(params, "height") === "auto",
    pageSize,
  };

  // localStorage is per-origin, so the root layout's no-flash script finds an
  // empty store inside a cross-origin frame and falls through to Light. ?theme
  // lets the host page say which palette it wants. The two class names and the
  // mode -> class mapping are the same ones applyMode() in
  // components/ThemeToggle.tsx stamps; changing either without the other is a
  // flash of the wrong palette.
  const theme = one(params, "theme");
  const themeScript =
    theme === "dark" || theme === "system" || theme === "light"
      ? `(function(){try{var c=document.documentElement.classList;c.toggle("dark",${
          theme === "dark"
        });c.toggle("claude",${theme === "system"});}catch(e){}})();`
      : null;

  // The host page may want its own background behind a sparse grid. body paints
  // an opaque bg-bg, which wins over the UA default, so it takes an override.
  const transparent = one(params, "bg") === "transparent";

  return (
    <>
      {themeScript && (
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      )}
      {transparent && (
        <style
          dangerouslySetInnerHTML={{
            __html: "body{background:transparent!important}",
          }}
        />
      )}
      <div
        className={
          config.autoHeight
            ? "font-sans text-text"
            : "h-screen overflow-hidden font-sans text-text"
        }
      >
        <EmbedGallery config={config} />
      </div>
    </>
  );
}
