// Public SSO constants — deliberately NOT env vars.
//
// Both values are public: the Google client ID is served in the auth broker's
// own client bundle, and the app id is just this app's name at the broker.
//
// Hardcoding them is what lets this feature avoid a NEXT_PUBLIC_* var, which
// this repo's build pipeline cannot deliver: Next inlines NEXT_PUBLIC_* at
// BUILD time, and the Docker builder stage receives no env vars (cloudbuild.yaml
// runs `docker build` with no --build-arg). A NEXT_PUBLIC_ var set on Cloud Run
// would be `undefined` in the browser — failing only in production, never in
// `npm run dev`. See DEPLOY.md: "All env vars are read at runtime".
//
// The one genuine secret, DWP_AUTH_SECRET, is read server-side only (lib/auth.ts).

export const GOOGLE_CLIENT_ID =
  "135031093260-4iec4up5qpt983umuru4t1042820qqsu.apps.googleusercontent.com";

// This app's registered id at the broker. process.env.APP_ID overrides it.
export const DEFAULT_APP_ID = "dwp-dam";

// The cookie the session JWT lives in.
export const SESSION_COOKIE = "dwp_session";

// The second cookie carrying the SAME session JWT, for the embeddable gallery
// at /embed only.
//
// SESSION_COOKIE is SameSite=Lax, which a browser does not send with ANY
// request made from inside a cross-site <iframe> — not the frame's document,
// not its fetches, not its <img>. An embedded gallery would therefore always
// render signed-out, however recently the viewer signed in. This cookie is
// SameSite=None so it does ride along; middleware.ts accepts it only for
// GET/HEAD on the embed surface, so it can never authorise a write and the
// CSRF protection Lax gives every POST is untouched.
export const EMBED_COOKIE = "dwp_embed";

// And a third, same token again, with Partitioned added.
//
// EMBED_COOKIE covers a frame whose browser still allows third-party cookies,
// or has granted Storage Access. Chrome with third-party cookies off, and
// Firefox with Total Cookie Protection, reject an unpartitioned cookie written
// from a frame outright — but accept a Partitioned one, stored against the pair
// (embedding site, this origin). That is what lets someone sign in INSIDE the
// embed and stay signed in there.
//
// It cannot simply replace EMBED_COOKIE: a Partitioned cookie written at the
// top level lands in a different jar from the frame's, so the two are not
// interchangeable and both are set.
export const FRAME_COOKIE = "dwp_frame";
