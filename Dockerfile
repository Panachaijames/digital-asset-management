# syntax=docker/dockerfile:1

# Multi-stage build for a Next.js 15 (App Router) app, producing a small
# runtime image from Next's "standalone" output. No build-time secrets are
# needed: every env var this app reads (SUPABASE_*, GOOGLE_SERVICE_ACCOUNT_*)
# is consumed only at runtime and injected by Cloud Run at deploy time.

# ---- deps: install node_modules (incl. devDeps needed to build) ----
FROM node:20-alpine AS deps
# Some transitive deps expect glibc; libc6-compat is a no-op otherwise.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install from the lockfile only, for deterministic, cache-friendly builds.
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: next build -> .next/standalone ----
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholders ONLY. lib/supabase.ts calls createClient() at module
# scope, which runs when Next imports the API route modules during "Collecting
# page data"; supabase-js throws "supabaseUrl is required." on an undefined URL,
# aborting the build. No DB call happens at build (route handlers are dynamic),
# so these fake values are never used. They live only in this builder stage and
# are NOT carried into the runner image, where Cloud Run injects the real values.
ENV SUPABASE_URL=https://placeholder.supabase.co
ENV SUPABASE_ANON_KEY=placeholder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal production image ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT (default 8080) at runtime; default it here too.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone bundle: a self-contained server.js + only the traced node_modules.
# .next/static and public/ are NOT included in the bundle and must be copied.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]
