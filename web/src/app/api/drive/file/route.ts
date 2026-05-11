/**
 * Stream a Drive file's bytes back to the browser as same-origin
 * content so the embedded PDF.js viewer (or a <video> tag) can
 * consume it without CORS pain. Auth-gated: the user can only
 * fetch files the SPA's drive.file scope already covers — that's
 * the same enforcement Drive itself does.
 *
 *   GET /api/drive/file?id=<driveFileId>
 */
import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getGoogleAccessToken } from '@/lib/google';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });
  const userId = (session.user as { id: string }).id;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return new Response('Missing id', { status: 400 });

  const token = await getGoogleAccessToken(userId);
  const upstream = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!upstream.ok) {
    return new Response(`Drive ${upstream.status}`, { status: upstream.status });
  }
  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/pdf',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
