import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { db, schema } from '@/db';
import { eq, and, asc, desc } from 'drizzle-orm';
import { Nav } from '@/components/nav';
import { GraphView } from './graph-view';

export const metadata = { title: 'Graph' };

export default async function GraphPage() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  const userId = (session.user as { id: string }).id;

  // Order sections explicitly so the top-nav doesn't reshuffle when
  // navigating between Graph/Schedule and the rest of the app —
  // Home/Settings/section pages all use the same `order` column.
  const sections = await db.query.sections.findMany({
    where: and(eq(schema.sections.userId, userId), eq(schema.sections.enabled, true)),
    orderBy: [asc(schema.sections.order)],
  });
  const rows = await db.query.rows.findMany({
    where: and(eq(schema.rows.userId, userId), eq(schema.rows.deleted, false)),
    orderBy: [desc(schema.rows.updatedAt)],
  });

  // Build a URL → rowId index so edges can be derived without
  // shipping every row.data over the wire.
  const urlIndex: Record<string, string> = {};
  for (const r of rows) {
    const data = r.data as Record<string, unknown>;
    if (typeof data.url === 'string' && data.url) urlIndex[data.url] = r.id;
  }

  type Node = {
    id: string; title: string; sectionId: string; sectionSlug: string;
    /** Citations-of, when known (paper rows enriched from Semantic
     *  Scholar at import). Drives the bubble radius — undefined
     *  renders at the baseline (we don't know, not zero). */
    citationCount?: number;
  };
  type Edge = { from: string; to: string; via: string };

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  for (const r of rows) {
    const s = sectionById.get(r.sectionId);
    if (!s) continue;
    const data = r.data as Record<string, unknown>;
    const cc = typeof data.citationCount === 'number' ? data.citationCount : undefined;
    nodes.push({
      id: r.id,
      title: String(data.title || data.name || '(untitled)'),
      sectionId: r.sectionId,
      sectionSlug: s.slug,
      ...(cc !== undefined ? { citationCount: cc } : {}),
    });
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string' || !v) continue;
      const target = urlIndex[v];
      if (target && target !== r.id) edges.push({ from: r.id, to: target, via: k });
    }
  }

  return (
    <>
      <Nav sections={sections} email={session.user.email} />
      <GraphView
        nodes={nodes}
        edges={edges}
        sections={sections.map((s) => ({ id: s.id, title: s.title, slug: s.slug }))}
      />
    </>
  );
}
