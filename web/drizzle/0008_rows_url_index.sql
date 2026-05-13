-- Expression index on `rows.data ->> 'url'` so Add-by-URL dedupe,
-- inbox lookups, and "find row by URL" search stop full-scanning
-- the rows table. CONCURRENTLY avoids blocking writes while the
-- index builds — important for a multi-user PG that's serving
-- live traffic during the migration.
--
-- The runtime query is `WHERE "userId" = $1 AND (data ->> 'url') = $2`,
-- so we index on (userId, expr) — the leading column matches the
-- existing per-user scoping and PG can satisfy the dedupe predicate
-- entirely from this index.
CREATE INDEX IF NOT EXISTS rows_user_url_idx
  ON rows ("userId", (data ->> 'url'))
  WHERE deleted = false;
