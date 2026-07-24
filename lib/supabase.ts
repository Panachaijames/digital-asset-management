import { createClient } from "@supabase/supabase-js";

// Used from the server-side API routes. Uses the anon (public) key: the
// `common_dam_assets` table has RLS disabled (see supabase/schema.sql) and Supabase
// grants the anon role full DML on public tables by default, so the anon key
// can read and write it. If you ever ENABLE row-level security on common_dam_assets,
// add policies that permit these inserts/selects (or switch back to the
// service_role key). Note there is still no auth in front of these routes —
// add your own (e.g. dwp.com SSO) before exposing this beyond local use.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
  {
    auth: { persistSession: false },
  }
);
