// A supabase-js client for the v2 project, scoped to ONE minted token.
//
// Created per call, never at module scope (see lib/v2/config.ts) and never
// shared across principals: the Authorization header IS the identity, and RLS
// plus the SECURITY DEFINER RPCs decide everything from its `sub`. The anon key
// only bootstraps PostgREST (SPEC 3.10.1).
//
// Server-side only. The browser never sees the token or this client.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { v2Config } from "./config";

export function v2Client(token: string): SupabaseClient {
  const { url, anonKey } = v2Config();
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { Authorization: "Bearer " + token } },
  });
}
