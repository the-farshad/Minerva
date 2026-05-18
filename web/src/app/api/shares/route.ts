/**
 * POST /api/shares  — owner creates a share.
 *   { scope: 'section'|'row', targetId, mode?: 'view'|'edit',
 *     usernames: string[] }
 *
 * GET  /api/shares?direction=incoming  — list incoming shares for me
 *                 ?direction=outgoing  — list my outgoing shares
 *
 * Sharing Phase 2. Public-link recipients (publicToken) land in
 * Phase 3; this route only handles user-to-user shares.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db, schema } from '@/db';
import { bus } from '@/lib/event-bus';

export const dynamic = 'force-dynamic';

type CreateBody = {
  scope?: 'section' | 'group' | 'row';
  targetId?: string;
  mode?: 'view' | 'edit';
  usernames?: string[];
  /** When true, emit a publicToken recipient instead of (or in
   *  addition to) usernames. Public-link recipients are always
   *  view-only regardless of `mode`. */
  publicLink?: boolean;
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const ownerUserId = (session.user as { id: string }).id;
  const body = (await req.json().catch(() => ({}))) as CreateBody;
  if (!body.targetId || !body.scope) return NextResponse.json({ error: 'Missing targetId or scope.' }, { status: 400 });
  if (body.scope !== 'section' && body.scope !== 'row' && body.scope !== 'group') {
    return NextResponse.json({ error: 'Invalid scope.' }, { status: 400 });
  }
  const mode: 'view' | 'edit' = body.mode === 'edit' ? 'edit' : 'view';
  const usernames = (body.usernames || []).map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (usernames.length === 0 && !body.publicLink) {
    return NextResponse.json({ error: 'No recipients — add a username or enable Public link.' }, { status: 400 });
  }

  // Ownership check: the owner must actually own the target.
  // For scope='group' the targetId is sectionId:groupKey — we
  // verify the section. Rows live inside sections which already
  // belong to the user, so a section ownership check covers all
  // three scopes.
  if (body.scope === 'section') {
    const sec = await db.query.sections.findFirst({
      where: and(eq(schema.sections.id, body.targetId), eq(schema.sections.userId, ownerUserId)),
    });
    if (!sec) return NextResponse.json({ error: 'Section not found or not yours.' }, { status: 404 });
  } else if (body.scope === 'group') {
    const sectionId = body.targetId.split(':')[0];
    const sec = await db.query.sections.findFirst({
      where: and(eq(schema.sections.id, sectionId), eq(schema.sections.userId, ownerUserId)),
    });
    if (!sec) return NextResponse.json({ error: 'Section not found or not yours.' }, { status: 404 });
  }

  // Resolve usernames → user ids. Missing usernames are returned in
  // the response so the caller can flag them in the UI. When the
  // request is public-link-only (no usernames), this path is
  // skipped and `usable` stays empty.
  let usable: { id: string; username: string | null }[] = [];
  let missing: string[] = [];
  if (usernames.length > 0) {
    const recipients = await db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .where(and(
        eq(schema.users.discoverable, true),
        sql`lower(${schema.users.username}) IN (${sql.join(usernames.map((u) => sql`${u}`), sql`, `)})`,
      ));
    const found = new Set(recipients.map((r) => r.username!.toLowerCase()));
    missing = usernames.filter((u) => !found.has(u));
    const selfHandle = (await db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, ownerUserId))
      .limit(1))[0]?.username?.toLowerCase();
    usable = recipients.filter((r) => r.username?.toLowerCase() !== selfHandle);
  }

  if (usable.length === 0 && !body.publicLink) {
    return NextResponse.json({
      error: 'No valid recipients.',
      missing,
    }, { status: 400 });
  }

  // Create the share + one recipient row per resolved user.
  const [share] = await db.insert(schema.shares).values({
    ownerUserId,
    scope: body.scope,
    targetId: body.targetId,
    defaultMode: mode,
  }).returning();

  if (usable.length > 0) {
    await db.insert(schema.shareRecipients).values(
      usable.map((r) => ({
        shareId: share.id,
        recipientUserId: r.id,
        mode,
      })),
    );
  }

  // Public-link recipient: one row carrying a URL-safe random
  // token. Recipients with publicToken set are auto-accepted
  // (no acceptance flow makes sense for an anonymous link). View-
  // only regardless of the share's defaultMode — an edit-capable
  // public link is a footgun.
  let publicUrl: string | null = null;
  if (body.publicLink) {
    const token = randomToken();
    await db.insert(schema.shareRecipients).values({
      shareId: share.id,
      publicToken: token,
      mode: 'view',
      acceptedAt: new Date(),
    });
    const origin = req.nextUrl.origin;
    publicUrl = `${origin}/share/${token}`;
  }

  // Notify recipients via SSE so their inbox badge lights up live.
  for (const r of usable) {
    bus.emit(r.id, { kind: 'share.received', shareId: share.id });
  }

  return NextResponse.json({
    id: share.id,
    recipients: usable.map((r) => ({ id: r.id, username: r.username })),
    missing,
    publicUrl,
  });
}

/** Cryptographically-random URL-safe id for public-link recipients.
 *  22 chars from a 132-bit pool — collision probability is negligible
 *  for the lifetime of any one Minerva install. */
function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64url without padding.
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const dir = req.nextUrl.searchParams.get('direction') || 'incoming';

  if (dir === 'outgoing') {
    // Owner's outgoing shares with recipient list + accept status.
    const rows = await db
      .select({
        id: schema.shares.id,
        scope: schema.shares.scope,
        targetId: schema.shares.targetId,
        mode: schema.shares.defaultMode,
        createdAt: schema.shares.createdAt,
        revokedAt: schema.shares.revokedAt,
      })
      .from(schema.shares)
      .where(and(eq(schema.shares.ownerUserId, userId), isNull(schema.shares.revokedAt)))
      .orderBy(desc(schema.shares.createdAt))
      .limit(100);
    if (rows.length === 0) return NextResponse.json({ shares: [] });
    // Recipients per share — one extra query, joined by id.
    const ids = rows.map((r) => r.id);
    const recs = await db
      .select({
        id: schema.shareRecipients.id,
        shareId: schema.shareRecipients.shareId,
        userId: schema.shareRecipients.recipientUserId,
        username: schema.users.username,
        mode: schema.shareRecipients.mode,
        acceptedAt: schema.shareRecipients.acceptedAt,
        declinedAt: schema.shareRecipients.declinedAt,
      })
      .from(schema.shareRecipients)
      .leftJoin(schema.users, eq(schema.users.id, schema.shareRecipients.recipientUserId))
      .where(inArray(schema.shareRecipients.shareId, ids));
    const byShare = new Map<string, typeof recs>();
    for (const r of recs) {
      const list = byShare.get(r.shareId) ?? [];
      list.push(r);
      byShare.set(r.shareId, list);
    }
    // Hydrate section titles for display.
    const sectionTargets = rows.filter((r) => r.scope === 'section').map((r) => r.targetId);
    const sectionTitles = sectionTargets.length === 0 ? new Map<string, string>() : new Map(
      (await db
        .select({ id: schema.sections.id, title: schema.sections.title })
        .from(schema.sections)
        .where(inArray(schema.sections.id, sectionTargets)))
        .map((s) => [s.id, s.title]),
    );
    return NextResponse.json({
      shares: rows.map((r) => ({
        ...r,
        targetTitle: r.scope === 'section' ? sectionTitles.get(r.targetId) ?? null : null,
        recipients: byShare.get(r.id) ?? [],
      })),
    });
  }

  // Incoming: shares where I'm the recipient, not yet declined and
  // the share itself isn't revoked.
  const rows = await db
    .select({
      recipientId: schema.shareRecipients.id,
      shareId: schema.shares.id,
      scope: schema.shares.scope,
      targetId: schema.shares.targetId,
      mode: schema.shareRecipients.mode,
      acceptedAt: schema.shareRecipients.acceptedAt,
      declinedAt: schema.shareRecipients.declinedAt,
      createdAt: schema.shareRecipients.createdAt,
      ownerId: schema.shares.ownerUserId,
      ownerUsername: schema.users.username,
      ownerName: schema.users.name,
    })
    .from(schema.shareRecipients)
    .innerJoin(schema.shares, eq(schema.shares.id, schema.shareRecipients.shareId))
    .leftJoin(schema.users, eq(schema.users.id, schema.shares.ownerUserId))
    .where(and(
      eq(schema.shareRecipients.recipientUserId, userId),
      isNull(schema.shares.revokedAt),
      isNull(schema.shareRecipients.declinedAt),
    ))
    .orderBy(desc(schema.shareRecipients.createdAt))
    .limit(100);

  const sectionTargets = rows.filter((r) => r.scope === 'section').map((r) => r.targetId);
  const sectionTitles = sectionTargets.length === 0 ? new Map<string, string>() : new Map(
    (await db
      .select({ id: schema.sections.id, title: schema.sections.title })
      .from(schema.sections)
      .where(inArray(schema.sections.id, sectionTargets)))
      .map((s) => [s.id, s.title]),
  );

  return NextResponse.json({
    shares: rows.map((r) => ({
      ...r,
      targetTitle: r.scope === 'section' ? sectionTitles.get(r.targetId) ?? null : null,
    })),
  });
}
