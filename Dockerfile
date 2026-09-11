# syntax=docker/dockerfile:1

# Multi-stage build for Next.js standalone output on Cloud Run.
# See docs/adr/0001-gcp-deploy-target.md.

FROM node:22-alpine AS base

# Onboarding validates a submitted IANA timezone by asking the runtime to
# resolve it, and the picker is populated from the runtime's own catalogue
# (docs/adr/0007). A Node built with small-icu carries no catalogue and knows
# only UTC, which would leave the picker empty and reject every timezone a real
# user submits — in production only, while working perfectly on a dev machine.
#
# Official node images have shipped full-icu since Node 13, so this should
# always pass; it is here because the failure is otherwise invisible until a
# user hits it. Failing the image build is the cheap place to find out.
RUN node -e "const n=Intl.supportedValuesOf('timeZone').length; if (n < 300) { console.error('small-icu runtime: only '+n+' timezones. Add icu-data-full or use node:22-slim.'); process.exit(1) } console.log('ICU timezone catalogue: '+n)"


# --- deps: install node_modules from the lockfile only -----------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./

# node:22-alpine ships npm 10, but package-lock.json is written by npm 11, which
# records each optional platform package (@esbuild/aix-ppc64 and friends) in a
# form npm 10 reads as required rather than optional. `npm ci` then tries to
# install every platform's binary and dies with EBADPLATFORM on the first one
# that is not linux/x64. Matching the npm that wrote the lockfile is what keeps
# the install reproducible; bump this when the lockfile's npm moves.
RUN npm i -g npm@11.16.0
RUN npm ci


# --- builder: compile the app ------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next inlines NEXT_PUBLIC_* values at build time, so they must be present here,
# not only at runtime. Server-only secrets stay out of the image entirely and
# arrive via Secret Manager at runtime.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

# Next salts every Server Action's id with this key and bakes it into the build
# output, so it is a build input rather than a runtime secret — see
# docs/adr/0008-server-actions-key-is-a-build-input.md.
#
# Left unset, Next generates a random key instead, and inside Docker its key
# cache is disabled entirely (`getStorageDirectory` returns undefined when
# `is-docker` is true), so that is a different key on *every* image build. The
# resulting image works perfectly until a rolling deploy puts two revisions side
# by side and every action reference from the older one stops resolving. Nothing
# about the build would tell you. Hence the check, in the same spirit as the ICU
# one above: failing the image build is the cheap place to find out.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
RUN node -e "const k=process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; if(!k){console.error('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is empty. Pass it with --build-arg; cloudbuild.yaml does. Generate one with: openssl rand -base64 32'); process.exit(1)} const n=Buffer.from(k,'base64').length; if(n!==16&&n!==24&&n!==32){console.error('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY decodes to '+n+' bytes; AES needs 16, 24 or 32. A bad length does not fail here without this check — it fails inside crypto.subtle.importKey the first time a user invokes an action. Generate one with: openssl rand -base64 32'); process.exit(1)} console.log('Server Action encryption key: '+n+' bytes')"

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


# --- runner: minimal runtime image -------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# `standalone` already contains a pruned node_modules and server.js.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# Cloud Run injects PORT and routes to it; the server must bind 0.0.0.0, not
# localhost, or the container fails its health check.
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
