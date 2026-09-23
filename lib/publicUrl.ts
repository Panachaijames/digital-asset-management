// Works out the origin Google's servers should use to fetch our images.
//
// Slides export is the one feature where a URL we generate has to be reachable
// from OUTSIDE this process: the Slides API downloads each image itself. So a
// request-derived "http://localhost:3000" is useless, and failing early with a
// clear message beats a batchUpdate that dies with Google's opaque
// "There was a problem retrieving the image".
//
// DAM_PUBLIC_BASE_URL wins when set (it also lets `npm run dev` drive a Slides
// export: the deployed service serves the same Drive files and validates the
// same signature, so images resolve against production while the export logic
// runs locally). Otherwise we reconstruct the origin from the proxy headers
// Cloud Run sets.

const PRIVATE_HOST =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.*\.local|.*\.internal)$/i;

export type PublicBaseUrl =
  | { ok: true; base: string }
  | { ok: false; message: string };

function check(raw: string, source: string): PublicBaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `${source} is not a valid URL: "${raw}".` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: `${source} must be http(s): "${raw}".` };
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    return {
      ok: false,
      message:
        `Slides export needs a publicly reachable address — Google fetches each image itself — but ${source} ` +
        `is "${url.host}". Set DAM_PUBLIC_BASE_URL to the deployed service URL (e.g. https://dwp-dam-….a.run.app) ` +
        `and try again; the deployed service serves the same Drive files, so exporting from a local dev server works too.`,
    };
  }
  return { ok: true, base: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}` };
}

export function resolvePublicBaseUrl(headers: Headers): PublicBaseUrl {
  const configured = (process.env.DAM_PUBLIC_BASE_URL || "").trim();
  if (configured) return check(configured, "DAM_PUBLIC_BASE_URL");

  const host = headers.get("x-forwarded-host") || headers.get("host");
  if (!host) {
    return {
      ok: false,
      message:
        "Couldn't work out this service's public address. Set DAM_PUBLIC_BASE_URL to the deployed service URL.",
    };
  }
  const proto = headers.get("x-forwarded-proto") || "https";
  return check(`${proto}://${host}`, "this request's host");
}
