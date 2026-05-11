/**
 * Accept a binary blob from the browser, upload to the user's
 * "Minerva offline" Drive folder, return the new fileId. Used by the
 * PDF annotation roundtrip — pdf.js emits the edited PDF bytes
 * client-side, this endpoint forwards them to Drive without staging
 * on disk.
 *
 *   POST /api/drive/upload   (multipart/form-data: file, name?)
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { uploadToMinervaDrive } from '@/lib/drive';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  }
  const name = String(form.get('name') || 'minerva-upload.bin').slice(0, 200);
  const mime = file.type || 'application/octet-stream';
  const bytes = await file.arrayBuffer();
  try {
    const up = await uploadToMinervaDrive(userId, bytes, name, mime);
    return NextResponse.json({ fileId: up.id, name });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
