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
  // Forward the client's Range header so <video> can seek and start
  // playback before the full file is buffered. Drive supports Range
  // on alt=media and will respond with 206 + Content-Range, which we
  // pass through verbatim.
  const reqHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
  const range = req.headers.get('range');
  if (range) reqHeaders.Range = range;
  const upstream = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
    { headers: reqHeaders, cache: 'no-store' },
  );
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Drive ${upstream.status}`, { status: upstream.status });
  }
  const respHeaders: Record<string, string> = {
    'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
    'Cache-Control': 'private, max-age=300',
    'Accept-Ranges': 'bytes',
  };
  const cr = upstream.headers.get('Content-Range');
  if (cr) respHeaders['Content-Range'] = cr;
  const cl = upstream.headers.get('Content-Length');
  if (cl) respHeaders['Content-Length'] = cl;
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
