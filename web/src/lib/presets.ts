/**
 * Section presets — same shape as v1's `_config` rows but expressed
 * as plain TS so they survive a fresh DB and any future migration.
 *
 * Each preset describes the section's slug, title, icon, and the
 * column schema (header names + their type hints — used only by
 * the SPA for rendering / validation).
 */
export type SectionPreset = {
  slug: string;
  title: string;
  icon: string;
  preset: string;
  defaultSort?: string;
  defaultFilter?: string;
  schema: { headers: string[]; types: string[] };
};

export const PRESETS: SectionPreset[] = [
  {
    slug: 'meets',
    title: 'Meeting polls',
    icon: 'calendar',
    preset: 'meetings',
    // No row-shaped schema — this section is a thin wrapper over
    // the polls table (which has its own schema). section-view
    // detects preset === 'meetings' and renders the polls index
    // inline instead of the usual rows grid.
    schema: { headers: [], types: [] },
  },
  {
    slug: 'notes',
    title: 'Notes',
    icon: 'book-open',
    preset: 'notes',
    defaultSort: 'created:desc',
    schema: {
      headers: ['id', 'title', 'category', 'tags', 'content', 'attachments', 'created', '_updated'],
      types: [
        'text', 'text',
        'multiselect()',
        'multiselect()',
        'markdown', 'longtext', 'datetime', 'datetime',
      ],
    },
  },
  {
    slug: 'tasks',
    title: 'Tasks',
    icon: 'check-square',
    preset: 'tasks',
    defaultSort: 'due',
    defaultFilter: 'status:!=done',
    schema: {
      headers: ['id', 'title', 'status', 'priority', 'due', 'project', 'link', 'notes', '_updated'],
      types: [
        'text', 'text', 'select(todo,doing,done)', 'select(low,med,high)',
        'date', 'ref(projects)', 'link', 'longtext', 'datetime',
      ],
    },
  },
  {
    slug: 'projects',
    title: 'Projects',
    icon: 'folder',
    preset: 'projects',
    defaultSort: 'name',
    schema: {
      headers: ['id', 'name', 'status', 'start', 'end', 'goal', 'description', '_updated'],
      types: [
        'text', 'text', 'select(planning,active,done,paused)',
        'date', 'date', 'ref(goals)', 'markdown', 'datetime',
      ],
    },
  },
  {
    slug: 'notes',
    title: 'Notes',
    icon: 'file-text',
    preset: 'notes',
    defaultSort: 'created:desc',
    schema: {
      headers: ['id', 'title', 'body', 'tags', 'created', '_updated'],
      types: ['text', 'text', 'markdown', 'multiselect()', 'datetime', 'datetime'],
    },
  },
  {
    slug: 'habits',
    title: 'Habits',
    icon: 'zap',
    preset: 'habits',
    schema: {
      headers: ['id', 'name', 'color', 'target', 'last_done', '_updated'],
      types: ['text', 'text', 'color', 'number', 'date', 'datetime'],
    },
  },
  {
    slug: 'youtube',
    title: 'YouTube tracker',
    icon: 'youtube',
    preset: 'youtube',
    schema: {
      headers: [
        'id', 'title', 'channel', 'duration', 'playlist', 'category',
        'url', 'thumbnail', 'published', 'watched', 'watched_at',
        'notes', 'links', 'offline', '_updated',
      ],
      types: [
        'text', 'text', 'text', 'text', 'text',
        'multiselect(tutorial,talk,lecture,documentary,course,interview,music,news,vlog,other)',
        'link', 'link', 'date', 'check', 'datetime',
        'markdown', 'longtext', 'text', 'datetime',
      ],
    },
  },
  {
    slug: 'inbox',
    title: 'Inbox',
    icon: 'inbox',
    preset: 'inbox',
    defaultSort: 'created:desc',
    schema: {
      headers: ['id', 'title', 'url', 'notes', 'created', '_updated'],
      types: ['text', 'text', 'link', 'markdown', 'datetime', 'datetime'],
    },
  },
  {
    slug: 'bookmarks',
    title: 'Bookmarks',
    icon: 'bookmark',
    preset: 'bookmarks',
    schema: {
      headers: ['id', 'title', 'url', 'tags', 'notes', '_updated'],
      types: ['text', 'text', 'link', 'multiselect()', 'markdown', 'datetime'],
    },
  },
  {
    slug: 'papers',
    title: 'Papers',
    icon: 'file-text',
    preset: 'papers',
    schema: {
      headers: [
        'id', 'title', 'authors', 'year', 'venue', 'volume', 'pages', 'doi',
        'url', 'pdf', 'offline', 'highlights', 'abstract',
        'category', 'tags', 'read', '_updated',
      ],
      types: [
        'text', 'text', 'text', 'number', 'text', 'text', 'text', 'text',
        'link', 'link', 'text', 'longtext', 'markdown',
        'multiselect(method,review,dataset,benchmark,position,survey,theory,application,other)',
        'multiselect()', 'check', 'datetime',
      ],
    },
  },
];
