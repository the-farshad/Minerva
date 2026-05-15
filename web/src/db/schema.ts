/**
 * Drizzle schema for Minerva v2.
 *
 * Multi-user from day one. Every row is keyed on `userId` so a single
 * Postgres can host every user without leakage. Soft-delete is the
 * default; hard delete only happens via account deletion.
 */
import {
  pgTable, text, timestamp, integer, bigint, boolean, jsonb, primaryKey,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';

// --- auth (NextAuth v5 / Auth.js drizzle adapter) ----------------

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  // Personal-data quotas — null means unlimited (defaults to a sane
  // cap on free tier). Stored as bigint because the default exceeds
  // 2 GB and individual videos / paper PDFs can be larger than that.
  quotaBytes: bigint('quotaBytes', { mode: 'number' }).default(5_000_000_000),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('providerAccountId').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (t) => ({
  pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
}));

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires').notNull(),
});

export const verificationTokens = pgTable('verificationTokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.identifier, t.token] }),
}));

// --- Minerva data model ------------------------------------------

/**
 * One row per user-defined section. Mirrors the v1 _config tab
 * conceptually but stored as proper rows. Slug is unique per user.
 */
export const sections = pgTable('sections', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  icon: text('icon'),
  order: integer('order').default(0).notNull(),
  schema: jsonb('schema').notNull(),         // {headers: [...], types: [...]}
  defaultSort: text('defaultSort'),
  defaultFilter: text('defaultFilter'),
  enabled: boolean('enabled').default(true).notNull(),
  preset: text('preset'),                     // 'tasks', 'youtube', 'papers', ...
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().notNull(),
}, (t) => ({
  uniqUserSlug: uniqueIndex('sections_user_slug_uniq').on(t.userId, t.slug),
}));

/**
 * Universal row. `data` is a JSONB blob shaped by the section's
 * schema. Per-user partition + GIN index for fast "find row by url"
 * searches.
 */
export const rows = pgTable('rows', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sectionId: text('sectionId').notNull().references(() => sections.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull(),
  deleted: boolean('deleted').default(false).notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().notNull(),
}, (t) => ({
  bySection: index('rows_section_idx').on(t.userId, t.sectionId, t.deleted),
}));

/** Per-user app preferences (theme, font, layout knobs, group notes,
 * sort orders, drag-drop reorder, video resume timestamps, …). One
 * row per user; `data` is an opaque JSONB the SPA owns end-to-end.
 */
export const userPrefs = pgTable('userPrefs', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updatedAt').defaultNow().notNull(),
});

/** Per-user file index — entries written by /api/files/save. Tracks
 * the host path of saved videos / papers / pdf-extract output so
 * the SPA can render them in the row's offline state and the
 * helper can clean up by user.
 */
export const files = pgTable('files', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rowId: text('rowId').references(() => rows.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),                 // 'video' | 'paper' | 'extract' | 'misc'
  filename: text('filename').notNull(),
  size: bigint('size', { mode: 'number' }).default(0).notNull(),
  driveFileId: text('driveFileId'),
  hostPath: text('hostPath'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, (t) => ({
  byUser: index('files_user_idx').on(t.userId, t.kind),
}));

/** Per-URL bookmarks for the preview modal — YouTube timestamps,
 * PDF page anchors, markdown note per bookmark. Lives at the URL
 * level (not row) so the same bookmark survives a row rename or
 * cross-section move. */
export const bookmarks = pgTable('bookmarks', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  kind: text('kind').notNull(),            // 'video' | 'pdf'
  ref: integer('ref').notNull(),            // seconds (video) | page (pdf)
  label: text('label').default('').notNull(),
  note: text('note').default('').notNull(),  // markdown
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, (t) => ({
  byUser: index('bookmarks_user_url_idx').on(t.userId, t.url),
}));

/** Meeting-poll definitions — organizer creates a poll with a list
 * of days and time slots; the public token (`/meet/<token>`) lets
 * participants submit availability without an account. The legacy
 * SPA encoded the whole poll into a URL token; this server-backed
 * version stores it properly so URLs stay short, responses don't
 * race, and the organizer can revoke or extend a poll later. */
/** Poll modes:
 *   'group' — multiple participants, each marks availability across
 *             the grid; organizer reads the consensus heat-map and
 *             optionally finalizes a slot.
 *   'book'  — Calendly-style 1-to-1. Organizer publishes a list of
 *             candidate slots. First participant who clicks a slot
 *             claims it; that cell becomes unavailable to everyone
 *             after. Each response carries exactly one `1` bit. */
export const polls = pgTable('polls', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** Short public slug used in the share URL. */
  token: text('token').notNull().unique(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** ISO date strings for the candidate days. */
  days: jsonb('days').notNull(),
  /** Compact JSON: { fromHour, toHour, slotMin, tz }. */
  slots: jsonb('slots').notNull(),
  /** When responses should stop being accepted (null = open-ended). */
  closesAt: timestamp('closesAt'),
  /** Where the meeting will happen — Zoom link, Google Meet URL,
   * physical address, "TBD", whatever. Shown verbatim to
   * participants so they can plan; not parsed. */
  location: text('location').default('').notNull(),
  /** Once the organizer picks a winning slot from the heat-map,
   * store it as "dayIdx:slotIdx" so the participant view can
   * highlight the final answer prominently. Null while the poll
   * is still open for input. */
  finalSlot: text('finalSlot'),
  /** 'group' (default) or 'book'. Drives participant-view UX and
   * server-side response validation. */
  mode: text('mode').default('group').notNull(),
  /** Poll kind. 'meeting' = the date/slot grid this table was
   * originally designed for. 'yesno' = single question, '1'/'0'/'?'
   * answers. 'ranked' = ordered preference over a list of options
   * (Borda count). For the latter two `days` is repurposed as the
   * option list and `slots` is a no-op placeholder. */
  kind: text('kind').default('meeting').notNull(),
  /** Optional shared-secret password. When set, participants must
   * supply it (server-validated) before reading the grid or
   * submitting a response. Stored as a sha-256 hex digest, not
   * plaintext, even though it's a soft-secret — the level of
   * effort needed to enforce it cleanly is the same either way. */
  passwordHash: text('passwordHash'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  updatedAt: timestamp('updatedAt').defaultNow().notNull(),
}, (t) => ({
  byUser: index('polls_user_idx').on(t.userId),
  byToken: index('polls_token_idx').on(t.token),
}));

export const pollResponses = pgTable('pollResponses', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  pollId: text('pollId').notNull().references(() => polls.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** One char per slot — '1' available, '0' not, '?' tentative.
   * Length must equal poll.days.length × slots-per-day. */
  bits: text('bits').notNull(),
  note: text('note').default('').notNull(),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, (t) => ({
  byPoll: index('pollResponses_poll_idx').on(t.pollId, t.createdAt),
}));

/** Queue table for the local-worker yt-dlp pattern. The droplet's
 *  IP is hard-blocked by YouTube anti-bot, so save-offline enqueues
 *  a job here and a trusted home-machine worker pulls them via
 *  /api/worker/jobs/next, runs yt-dlp on a residential IP, and
 *  posts the resulting Drive fileId back. The droplet only stores
 *  the queue + does the row's offline-marker patch — bytes never
 *  cross the droplet's network. */
export const downloadJobs = pgTable('download_jobs', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rowId: text('rowId').notNull().references(() => rows.id, { onDelete: 'cascade' }),
  sectionSlug: text('sectionSlug').notNull(),
  url: text('url').notNull(),
  format: text('format').default('mp4').notNull(),
  quality: text('quality').default('best').notNull(),
  /** pending | claimed | done | failed. Lifecycle in the migration's
   *  header comment. */
  status: text('status').default('pending').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  lastError: text('lastError'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
  claimedAt: timestamp('claimedAt'),
  completedAt: timestamp('completedAt'),
}, (t) => ({
  byStatusCreated: index('download_jobs_status_created_idx').on(t.status, t.createdAt),
  byUser: index('download_jobs_user_idx').on(t.userId),
}));

/** Activity log — each user's recent operations for an "undo" surface
 * + audit trail. */
export const events = pgTable('events', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('createdAt').defaultNow().notNull(),
}, (t) => ({
  byUser: index('events_user_idx').on(t.userId, t.createdAt),
}));

// --- public paper-lookup cache -----------------------------------
//
// Caches the JSON responses of lit.thefarshad.com's lookup chain
// (arXiv / CrossRef / Europe PMC / Semantic Scholar refs &
// citations / OpenAlex related) so repeat queries don't hammer the
// upstream APIs. Cross-user — the data is upstream-public and
// identical for every visitor, so there's no userId scoping. TTL
// is enforced in code by checking `fetchedAt` against a per-source
// freshness window, which lets the lookup chain pick "stale-is-
// fine" (metadata) vs "must-be-fresh" (citationCount) per row.
export const paperLookupCache = pgTable('paperLookupCache', {
  // Composite key — `${source}:${kind}:${id}[:opts]`, e.g.
  //   lookup:DOI:10.x/y
  //   refs:DOI:10.x/y:references
  //   related:openalex:ARXIV:2401.12345:50
  // The source prefix keeps namespaces separate so a stats hit
  // doesn't collide with a refs hit on the same paper id.
  key: text('key').primaryKey(),
  data: jsonb('data').notNull(),
  fetchedAt: timestamp('fetchedAt').defaultNow().notNull(),
}, (t) => ({
  byFetchedAt: index('paperLookupCache_fetchedAt_idx').on(t.fetchedAt),
}));
