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
