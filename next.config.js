/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker
  // runtime image only needs the traced node_modules, not the full install.
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "drive.google.com" },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // No headers() block. Framing is set by middleware.ts, which now runs on
  // /login and /api/session too, so every response gets its policy from one
  // place (lib/framing.ts). Adding a static rule here would silently win over
  // that for whichever path it matched.
};

module.exports = nextConfig;
