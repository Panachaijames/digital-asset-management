// Who the caller is in the v2 library: email -> dam_users row.
//
// Provisioning goes through the SECURITY DEFINER RPC dam_provision_user, called
// with the web tier's SYSTEM token — never the service-role key (SPEC D-375).
// The RPC owns every rule: it creates a first-time user as a viewer, activates
// them when their domain is in `users.auto_activate_domains`, updates only the
// login bookkeeping of an existing row, and never touches an existing row's
// role, active flag, visibility or display name. This file only asks and
// caches the answer.
//
// It runs in two places:
//   * app/api/session POST, best-effort, at sign-in (with name and picture);
//   * requireV2User(), lazily, on every /api/v2 call — because sessions last
//     until the broker token expires, and people already signed in when v2
//     ships never pass through the POST again.

import { v2Client } from "./client";
import { V2Error, fromPostgrest } from "./errors";
import { mintSystemToken } from "./jwt";

export type V2Role =
  | "viewer"
  | "contributor"
  | "editor"
  | "studio_admin"
  | "global_admin"
  | "owner";

export interface V2User {
  id: string;
  email: string;
  displayName: string;
  role: V2Role;
  // False for an inactive row AND for a trashed one: both are refused, and
  // dam_current_role() treats them the same way (null role, nothing visible).
  isActive: boolean;
  crossStudio: boolean;
}

// One row of dam_provision_user's result table.
interface ProvisionRow {
  id: string;
  email: string;
  display_name: string;
  role: V2Role;
  is_active: boolean;
  cross_studio_visibility: boolean;
  deleted_at: string | null;
  created: boolean;
}

const CACHE_MS = 60_000;
const MAX_CACHED = 2000;
const RPC_TIMEOUT_MS = 8_000;

// Per email. Holds the in-flight promise too, so the two parallel RPCs of one
// page load (or two tabs) provision once rather than racing.
const cache = new Map<string, { at: number; user: Promise<V2User> }>();

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toUser(row: ProvisionRow): V2User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active === true && !row.deleted_at,
    crossStudio: row.cross_studio_visibility === true,
  };
}

async function callProvision(
  email: string,
  name?: string | null,
  picture?: string | null
): Promise<V2User> {
  const client = v2Client(await mintSystemToken());
  const { data, error, status } = await client
    .rpc("dam_provision_user", {
      p_email: email,
      p_display_name: name?.trim() || null,
      p_picture_url: picture?.trim() || null,
    })
    .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));

  if (error) {
    // The RPC's own refusals mean something specific here:
    //   42501  "system principal required" — the web system principal
    //          (dam_users ...0005) is missing, i.e. the grants migration has
    //          not been applied. A server fault, not the person's.
    //   22023  the email is not one the library accepts (malformed, or a
    //          reserved system address).
    if (error.code === "42501" && status !== 401) {
      console.error("[v2] dam_provision_user refused the web system principal.");
      throw new V2Error(503, "v2_not_ready", "The project library has not been set up on this server yet.");
    }
    if (error.code === "22023") {
      throw new V2Error(403, "account_invalid", "This account cannot use the project library.");
    }
    throw fromPostgrest("dam_provision_user", { error, status });
  }

  const row = (Array.isArray(data) ? data[0] : data) as ProvisionRow | null | undefined;
  if (!row || typeof row.id !== "string") {
    console.error("[v2] dam_provision_user returned no row.");
    throw new V2Error(502, "v2_unavailable", "The project library did not return an account.");
  }
  return toUser(row);
}

function prune(now: number) {
  if (cache.size < MAX_CACHED) return;
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_MS) cache.delete(key);
  }
  for (const key of cache.keys()) {
    if (cache.size < MAX_CACHED) break;
    cache.delete(key);
  }
}

// Find or create the caller's dam_users row. Cached per email for 60 s, so an
// admin's change (activation, a new role) is picked up within a minute and a
// busy page costs one RPC a minute, not one per request. Failures are not
// cached: the next request tries again.
export function provisionV2User(input: {
  email: string;
  name?: string | null;
  picture?: string | null;
}): Promise<V2User> {
  const email = normaliseEmail(input.email);
  if (!email) {
    return Promise.reject(
      new V2Error(403, "account_invalid", "This account cannot use the project library.")
    );
  }
  const now = Date.now();
  const hit = cache.get(email);
  if (hit && now - hit.at < CACHE_MS) return hit.user;

  const user = callProvision(email, input.name, input.picture);
  prune(now);
  cache.set(email, { at: now, user });
  // Evict on failure, but only if it is still OUR entry (a later call may have
  // replaced it). The rejection itself is handled by whoever awaits `user`.
  user.catch(() => {
    if (cache.get(email)?.user === user) cache.delete(email);
  });
  return user;
}

// The caller of an /api/v2 route, provisioned and checked.
//
// `x-dwp-email` is trusted HERE because /api/v2 is inside middleware.ts's
// matcher and not in PUBLIC_PATHS: middleware strips any client-supplied copy
// and sets it from the verified session. Never call this from a route under an
// excluded path (/api/v1, /api/slides/image), where the header is spoofable.
//
// Never throws a 401 (see lib/v2/errors.ts): a missing dwp session was already
// answered by middleware, so anything that fails here is a v2 problem.
export async function requireV2User(request: Request): Promise<V2User> {
  const email = normaliseEmail(request.headers.get("x-dwp-email") ?? "");
  if (!email) {
    // Only possible if middleware did not run for this path — a routing or
    // matcher fault, which a 401 would turn into a sign-in loop.
    console.error("[v2] x-dwp-email missing on an /api/v2 request; is the route inside the middleware matcher?");
    throw new V2Error(500, "identity_unavailable", "This server could not identify you.");
  }
  const user = await provisionV2User({ email });
  if (!user.isActive) {
    throw new V2Error(
      403,
      "account_inactive",
      "Your account is not active in the project library yet. Ask a Global Admin to activate it."
    );
  }
  return user;
}
