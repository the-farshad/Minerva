# Minerva v2 (Next.js + TypeScript + React)

A multi-user rewrite of Minerva on the Next.js App Router with Drizzle
ORM + Postgres, Auth.js (Google OAuth), and Tailwind CSS.

The legacy SPA at the repo root keeps shipping while this lives
side-by-side. Once v2 hits parity, we cut over.

## Quick start

```bash
cp .env.example .env.local
#  fill in DATABASE_URL, AUTH_SECRET (`openssl rand -base64 32`),
#  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET

npx drizzle-kit push   # apply schema to your Postgres
npm run dev            # http://localhost:3000
```

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router |
| Language | TypeScript |
| UI | React 19 + Tailwind CSS v4 + Radix primitives |
| Auth | Auth.js (NextAuth v5) — Google OAuth, drive.file scope |
| ORM / DB | Drizzle ORM + Postgres |
| Data fetching | TanStack Query (client) + RSC (server) |
| Notifications | Sonner |
| Icons | Lucide |

## Structure

```
src/
  app/
    layout.tsx          root shell + Providers
    page.tsx            home (signed in / out)
    sign-in/page.tsx    Google sign-in
    s/[slug]/           per-section view (list + grid)
    settings/           preset gallery + account
    api/
      auth/[...nextauth]/   NextAuth route handlers
      sections/             section CRUD
      sections/[slug]/rows  row CRUD
  auth.ts               Auth.js config
  db/                   Drizzle schema + client
  lib/                  Google API helpers, utils, presets
  components/           Nav, etc.
```

## What's already in this scaffold

- Multi-user database schema with per-user row partitioning (Drizzle).
- Sign in with Google (drive.file scope).
- Home page that lists the user's installed sections.
- Settings page with the section-preset gallery (Tasks, Projects,
  Notes, Habits, YouTube, Papers).
- Per-section list + grid view with natural-numeric sort and
  add/edit/delete row through the API.
- Auth-gated API routes for sections + rows (every query scoped to
  the signed-in user).
- Token refresh helper that keeps the user's Google access token
  fresh from the stored refresh_token.
- Vector sketch editor (`components/sketch-modal.tsx`): multi-page
  canvas with pen / pencil / marker / highlighter / line / shapes /
  arrow / object-eraser / lasso, pan + pinch-zoom, paper sizes &
  backgrounds and a light/dark drawing surface (all grouped under a
  "Paper" popover), width / opacity / handwriting-smoothing under a
  "Pen" popover, a **Pencil-only** toggle (ignores finger/touch for
  drawing and pinch-zoom so a resting palm can't draw), and an
  **iPad text tool** — its editing overlay is a real `<textarea>`,
  so Apple Pencil Scribble converts handwriting to text on-device
  (the only way to reach Apple's handwriting model from Safari).
  Persists as a vector `SketchDoc` (JSON in `row.data._sketchDoc`)
  and exports to PDF / SVG.

## What's still TODO before sunsetting v1

- Full feature parity with v1 (preview modal, drag-drop, group sort,
  group notes, paper Drive mirror, YouTube downloads, FS Access
  local-disk mirror, …).
- Sheets ↔ DB sync — currently DB is the only backend.
- Helper proxy routes so the Python service still handles yt-dlp /
  PDF extract.
- Migration tool that walks an existing v1 user's Sheets data into
  the new DB.

## Running against the v1 helper

`HELPER_BASE_URL` lets the new app forward yt-dlp / pdf-extract
requests to the existing Python helper. No need to rewrite those —
the helper stays as a worker microservice.
