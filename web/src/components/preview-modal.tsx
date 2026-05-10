'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ExternalLink, Download, Save } from 'lucide-react';
import { toast } from 'sonner';

type PreviewItem = {
  url: string;
  title?: string;
  /** Drive fileId of an offline copy, when one has been mirrored. */
  driveFileId?: string;
  /** host:<path> marker if the helper has a copy on disk. */
  hostPath?: string;
  /** Row id — needed when the preview triggers a download or
   * auto-mirror that writes an offline marker back to the row. */
  rowId?: string;
  sectionSlug?: string;
};

const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/;
const PDF_RE = /\.pdf(\?|#|$)|arxiv\.org\/(?:abs|pdf)\//i;

function ytId(url: string) {
  const m = url.match(YT_RE);
  return m ? m[1] : null;
}
function isPdf(url: string) {
  return PDF_RE.test(url);
}

export function PreviewModal({
  item,
  onClose,
}: {
  item: PreviewItem | null;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(!!item), [item]);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!open && item) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!item) return null;

  const yt = ytId(item.url);
  const pdf = isPdf(item.url);
  const driveSrc = item.driveFileId
    ? `https://drive.google.com/file/d/${encodeURIComponent(item.driveFileId)}/preview`
    : null;
  const hostSrc = item.hostPath
    ? `/api/helper/file/serve?path=${encodeURIComponent(item.hostPath)}`
    : null;

  async function downloadOffline() {
    if (!item || !yt || !item.sectionSlug || !item.rowId) return;
    setDownloading(true);
    toast.info('Asking yt-dlp…');
    try {
      const r = await fetch('/api/helper/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url, format: 'mp4' }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`Download: ${r.status} ${txt.slice(0, 200)}`);
      }
      // For now we confirm the bytes arrived. Wiring the upload to
      // Drive (and the offline-marker writeback to the row) is the
      // next chunk — same pattern as v1's uploadOfflineToDrive.
      await r.arrayBuffer();
      toast.success('Downloaded.');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 z-50 m-0 flex flex-col bg-zinc-100 dark:bg-zinc-950 sm:inset-2 sm:rounded-xl sm:overflow-hidden">
          <header className="flex items-center gap-2 border-b border-zinc-200 bg-white/70 px-3 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70">
            <Dialog.Title className="flex-1 truncate text-sm font-medium">
              {item.title || item.url}
            </Dialog.Title>
            <a
              href={item.url}
              target="_blank"
              rel="noopener"
              title="Open in new tab"
              className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            {hostSrc && (
              <a
                href={hostSrc}
                download
                title="Download local copy"
                className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Download className="h-4 w-4" />
              </a>
            )}
            {yt && !item.hostPath && item.sectionSlug && item.rowId && (
              <button
                type="button"
                onClick={downloadOffline}
                disabled={downloading}
                title="Save this video for offline playback (yt-dlp)"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <Save className="h-3.5 w-3.5" /> {downloading ? 'Downloading…' : 'Download offline'}
              </button>
            )}
            <Dialog.Close
              aria-label="Close"
              className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>
          <div className="relative flex-1 bg-zinc-200 dark:bg-zinc-900">
            {hostSrc && pdf ? (
              <iframe
                src={`${hostSrc}#toolbar=1`}
                className="h-full w-full"
                title="PDF (host copy)"
              />
            ) : driveSrc && pdf ? (
              <iframe
                src={driveSrc}
                className="h-full w-full"
                title="PDF (Drive)"
                allow="autoplay"
              />
            ) : yt ? (
              <iframe
                src={`https://www.youtube.com/embed/${encodeURIComponent(yt)}?autoplay=1`}
                className="h-full w-full"
                title="YouTube"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : hostSrc ? (
              <video src={hostSrc} controls autoPlay className="h-full w-full bg-black" />
            ) : (
              <iframe
                src={item.url}
                className="h-full w-full"
                title={item.title || item.url}
                referrerPolicy="no-referrer"
                allow="fullscreen"
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
