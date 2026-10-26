FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

# better-sqlite3 (transitive via @ophan/core) needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/webapp/package.json packages/webapp/

RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/core/ packages/core/
COPY packages/webapp/ packages/webapp/

# Build core first (webapp depends on @ophan/core/schemas)
RUN pnpm --filter @ophan/core build

# Build webapp. Supabase config is read at runtime (SUPABASE_URL, SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, optional SUPABASE_PUBLIC_URL), so one image fits every server.
RUN pnpm --filter ophan-webapp build

# --- Runtime ---
FROM node:22-slim AS runtime

WORKDIR /app

# Nitro .output is self-contained (all deps bundled)
COPY --from=builder /app/packages/webapp/.output .output

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
