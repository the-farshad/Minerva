# Minerva v2 — Next.js 16 production image.
# Build context: this directory (web/). The companion docker-compose
# entry lives at docs/docker-compose.yml as a separate service.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL etc. are runtime — pass placeholders for build.
ENV DATABASE_URL=postgresql://x:x@127.0.0.1:5432/x \
    AUTH_SECRET=build-time-only \
    GOOGLE_OAUTH_CLIENT_ID=build \
    GOOGLE_OAUTH_CLIENT_SECRET=build \
    NEXTAUTH_URL=http://localhost:3000
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache tini curl unzip
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

# Bundle Mozilla's standalone PDF.js viewer so we can mount it via
# iframe with full annotation editor + highlight / sticky-note /
# free-text tools enabled. Stored at /app/public/pdfjs so Next
# serves it at /pdfjs/* under the same origin (required — the
# viewer iframe needs same-origin access to blob: URLs).
ARG PDFJS_VERSION=4.10.38
RUN curl -fsSL "https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip" -o /tmp/pdfjs.zip \
    && mkdir -p /app/public/pdfjs \
    && unzip -q /tmp/pdfjs.zip -d /app/public/pdfjs \
    && rm /tmp/pdfjs.zip

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx drizzle-kit migrate || true && npm run start"]
