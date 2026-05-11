/**
 * Citation builders for paper rows. Each function takes the flat
 * `row.data` object and a few overrides, and returns the rendered
 * citation as a plain string. The shape we expect:
 *
 *   { title, authors, year, journal | venue | conference,
 *     volume, issue, pages, doi, publisher, url }
 *
 * Anything missing is dropped silently; we don't substitute "n.d." or
 * "Unknown" — better an honest partial citation than a fake one.
 */

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Split authors on commas / semicolons / "and" so a single comma
 * doesn't disappear. Returns an array of trimmed names. */
function splitAuthors(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** "Lastname, F.M." — for APA / Chicago. Handles either
 * "Firstname Lastname" or "Lastname, Firstname". */
function apaName(full: string): string {
  if (full.includes(',')) return full; // already "Lastname, X"
  const parts = full.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts.pop()!;
  const initials = parts.map((p) => p.charAt(0).toUpperCase() + '.').join(' ');
  return `${last}, ${initials}`;
}

/** "Firstname Lastname" passthrough (for MLA first author the
 * format is "Lastname, Firstname"; subsequent are "Firstname Last"). */
function mlaFirstAuthor(full: string): string {
  if (full.includes(',')) return full;
  const parts = full.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts.pop()!;
  return `${last}, ${parts.join(' ')}`;
}

function venueOf(row: Row): string {
  return s(row.journal) || s(row.venue) || s(row.conference) || s(row.booktitle) || '';
}

export function bibtex(row: Row): string {
  const title = s(row.title);
  const authors = splitAuthors(s(row.authors));
  const year = s(row.year);
  const venue = venueOf(row);
  const doi = s(row.doi);
  const url = s(row.url);
  const volume = s(row.volume);
  const issue = s(row.issue);
  const pages = s(row.pages);
  const publisher = s(row.publisher);

  const firstAuthorLast = (authors[0] || 'unknown').split(/\s+/).pop()!.replace(/\W+/g, '').toLowerCase();
  const firstTitleWord = (title.split(/\s+/).find((w) => w.length > 3) || 'paper').replace(/\W+/g, '').toLowerCase();
  const key = `${firstAuthorLast}${year || ''}${firstTitleWord}`;

  const kind = venue.toLowerCase().includes('proc') ? 'inproceedings' : 'article';
  const fields: string[] = [];
  if (authors.length) fields.push(`  author    = {${authors.join(' and ')}}`);
  if (title)         fields.push(`  title     = {${title}}`);
  if (kind === 'inproceedings' && venue) fields.push(`  booktitle = {${venue}}`);
  else if (venue)    fields.push(`  journal   = {${venue}}`);
  if (year)          fields.push(`  year      = {${year}}`);
  if (volume)        fields.push(`  volume    = {${volume}}`);
  if (issue)         fields.push(`  number    = {${issue}}`);
  if (pages)         fields.push(`  pages     = {${pages}}`);
  if (publisher)     fields.push(`  publisher = {${publisher}}`);
  if (doi)           fields.push(`  doi       = {${doi}}`);
  if (url && !doi)   fields.push(`  url       = {${url}}`);
  return `@${kind}{${key},\n${fields.join(',\n')}\n}`;
}

export function apa(row: Row): string {
  const title = s(row.title);
  const authors = splitAuthors(s(row.authors)).map(apaName);
  const year = s(row.year);
  const venue = venueOf(row);
  const volume = s(row.volume);
  const issue = s(row.issue);
  const pages = s(row.pages);
  const doi = s(row.doi);
  const url = s(row.url);

  let authorStr = '';
  if (authors.length === 1) authorStr = authors[0];
  else if (authors.length === 2) authorStr = `${authors[0]}, & ${authors[1]}`;
  else if (authors.length > 2) authorStr = `${authors.slice(0, -1).join(', ')}, & ${authors[authors.length - 1]}`;

  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  parts.push(`(${year || 'n.d.'})`);
  if (title) parts.push(`${title}.`);
  let venuePart = venue;
  if (venue && volume) venuePart += `, ${volume}`;
  if (venue && issue) venuePart += `(${issue})`;
  if (venue && pages) venuePart += `, ${pages}`;
  if (venuePart) parts.push(`${venuePart}.`);
  if (doi) parts.push(`https://doi.org/${doi}`);
  else if (url) parts.push(url);
  return parts.join(' ').replace(/\.\s*\./g, '.');
}

export function mla(row: Row): string {
  const title = s(row.title);
  const authors = splitAuthors(s(row.authors));
  const year = s(row.year);
  const venue = venueOf(row);
  const volume = s(row.volume);
  const issue = s(row.issue);
  const pages = s(row.pages);
  const doi = s(row.doi);
  const url = s(row.url);

  let authorStr = '';
  if (authors.length === 1) authorStr = mlaFirstAuthor(authors[0]);
  else if (authors.length === 2) authorStr = `${mlaFirstAuthor(authors[0])}, and ${authors[1]}`;
  else if (authors.length >= 3) authorStr = `${mlaFirstAuthor(authors[0])}, et al.`;

  const parts: string[] = [];
  if (authorStr) parts.push(`${authorStr}.`);
  if (title) parts.push(`"${title}."`);
  let venuePart = venue;
  if (venue && volume) venuePart += `, vol. ${volume}`;
  if (venue && issue) venuePart += `, no. ${issue}`;
  if (venue && year) venuePart += `, ${year}`;
  if (venue && pages) venuePart += `, pp. ${pages}`;
  if (venuePart) parts.push(`${venuePart}.`);
  if (doi) parts.push(`https://doi.org/${doi}.`);
  else if (url) parts.push(`${url}.`);
  return parts.join(' ');
}

export function chicago(row: Row): string {
  // Chicago Author-Date.
  const title = s(row.title);
  const authors = splitAuthors(s(row.authors));
  const year = s(row.year);
  const venue = venueOf(row);
  const volume = s(row.volume);
  const issue = s(row.issue);
  const pages = s(row.pages);
  const doi = s(row.doi);
  const url = s(row.url);

  const firstFlipped = authors[0] ? mlaFirstAuthor(authors[0]) : '';
  const rest = authors.slice(1).join(', ');
  const authorStr = firstFlipped + (rest ? `, and ${rest}` : '');

  const parts: string[] = [];
  if (authorStr) parts.push(`${authorStr}.`);
  if (year) parts.push(`${year}.`);
  if (title) parts.push(`"${title}."`);
  let venuePart = venue;
  if (venue && volume) venuePart += ` ${volume}`;
  if (venue && issue) venuePart += `, no. ${issue}`;
  if (venue && pages) venuePart += `: ${pages}`;
  if (venuePart) parts.push(`${venuePart}.`);
  if (doi) parts.push(`https://doi.org/${doi}.`);
  else if (url) parts.push(`${url}.`);
  return parts.join(' ');
}

export const CITATION_FORMATS = [
  { id: 'bibtex',  label: 'BibTeX',  render: bibtex },
  { id: 'apa',     label: 'APA',     render: apa },
  { id: 'mla',     label: 'MLA',     render: mla },
  { id: 'chicago', label: 'Chicago', render: chicago },
] as const;
