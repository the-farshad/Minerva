'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ExternalLink, Download, Save } from 'lucide-react';
import { toast } from 'sonner';
import { BookmarkDrawer } from './bookmark-drawer';
import { NotesPane } from './notes-pane';
import { readPref, writePref } from '@/lib/prefs';
import { StickyNote } from 'lucide-react';

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
  /** Current `notes` value for the row, for the side pane. */
  notes?: string;
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
  const ytIframeRef = useRef<HTMLIFrameElement>(null);
  const ytTimeRef = useRef<number>(0);
  const [pdfPage, setPdfPage] = useState(1);
  const [notesOpen, setNotesOpen] = useState(false);
  // Local mirror of the item so async writes (auto-mirror, manual
  // download) can flip the modal to a freshly-uploaded Drive blob
  // without the parent re-rendering.
  const [view, setView] = useState<PreviewItem | null>(item);
  useEffect(() => { setView(item); }, [item]);
  useEffect(() => {
    if (!open && item) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Listen for postMessage from the YT iframe's IFrame API so we
  // can track current time + persist a resume position. The iframe
  // is mounted with `enablejsapi=1` below; postMessage handshake is
  // documented at https://developers.google.com/youtube/iframe_api_reference
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (typeof ev.data !== 'string') return;
      try {
        const m = JSON.parse(ev.data) as { event?: string; info?: { currentTime?: number } };
        if (m?.info && typeof m.info.currentTime === 'number') {
          ytTimeRef.current = m.info.currentTime;
        }
      } catch { /* not our message */ }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Persist resume position when leaving a YT video. Local-only
  // for now (per-device); a future build pushes through userprefs.
  useEffect(() => {
    return () => {
      const v = view;
      if (!v) return;
      const yt = ytId(v.url);
      if (!yt) return;
      const t = Math.floor(ytTimeRef.current);
      if (t > 5) writePref(`resume.${v.url}`, t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!view) return null;

  const yt = ytId(view.url);
  const pdf = isPdf(view.url);
  const ytResume = yt ? readPref<number>(`resume.${view.url}`, 0) : 0;
  const driveSrc = view.driveFileId
    ? `https://drive.google.com/file/d/${encodeURIComponent(view.driveFileId)}/preview`
    : null;
  const hostSrc = view.hostPath
    ? `/api/helper/file/serve?path=${encodeURIComponent(view.hostPath)}`
    : null;

  async function saveOffline(kind: 'video' | 'paper') {
    if (!view || !view.sectionSlug || !view.rowId) return;
    setDownloading(true);
    toast.info(kind === 'video' ? 'Downloading + uploading to Drive…' : 'Mirroring PDF to Drive…');
    try {
      const r = await fetch(
        `/api/sections/${view.sectionSlug}/rows/${view.rowId}/save-offline`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `save-offline: ${r.status}`);
      toast.success(j.skipped ? 'Already offline.' : 'Saved to Drive.');
      setView((prev) => (prev ? { ...prev, driveFileId: j.fileId } : prev));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  // Paper auto-mirror on first preview-open: fire and forget so
  // the iframe can start loading the (probably-X-Frame-blocked)
  // arxiv URL while the helper grabs the PDF in the background.
  useEffect(() => {
    const v = view;
    if (!v) return;
    if (!isPdf(v.url)) return;
    if (v.driveFileId || v.hostPath) return;
    if (!v.rowId || !v.sectionSlug) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/sections/${v.sectionSlug}/rows/${v.rowId}/save-offline`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'paper' }),
          },
        );
        if (cancelled) return;
        if (!r.ok) return;
        const j = await r.json().catch(() => ({}));
        if (j.fileId) setView((prev) => (prev ? { ...prev, driveFileId: j.fileId } : prev));
      } catch { /* tolerate */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.url, view?.rowId]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 z-50 m-0 flex flex-col bg-zinc-100 dark:bg-zinc-950 sm:inset-2 sm:rounded-xl sm:overflow-hidden">
          <header className="flex items-center gap-2 border-b border-zinc-200 bg-white/70 px-3 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70">
            <Dialog.Title className="flex-1 truncate text-sm font-medium">
              {view.title || view.url}
            </Dialog.Title>
            <a
              href={view.url}
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
            {yt && !view.driveFileId && !view.hostPath && view.sectionSlug && view.rowId && (
              <button
                type="button"
                onClick={() => saveOffline('video')}
                disabled={downloading}
                title="Download via yt-dlp + upload to Drive so this plays offline"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <Save className="h-3.5 w-3.5" /> {downloading ? 'Saving…' : 'Save offline'}
              </button>
            )}
            {view.sectionSlug && view.rowId && (
              <button
                type="button"
                onClick={() => setNotesOpen((v) => !v)}
                title="Show / hide notes pane"
                className={`rounded-full p-1.5 ${notesOpen ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
              >
                <StickyNote className="h-4 w-4" />
              </button>
            )}
            <Dialog.Close
              aria-label="Close"
              className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>
          <div className="flex flex-1 overflow-hidden">
            <div className="relative flex-1 bg-zinc-200 dark:bg-zinc-900">
            {(hostSrc || driveSrc) && pdf ? (
              <iframe
                src={`/pdfjs/web/viewer.html?file=${encodeURIComponent(
                  hostSrc ?? `/api/drive/file?id=${view.driveFileId}`,
                )}#page=${pdfPage}`}
                className="h-full w-full"
                title="PDF (annotated viewer)"
              />
            ) : yt ? (
              <iframe
                ref={ytIframeRef}
                src={`https://www.youtube.com/embed/${encodeURIComponent(yt)}?autoplay=1&enablejsapi=1&start=${ytResume}&origin=${encodeURIComponent(typeof window !== 'undefined' ? location.origin : '')}`}
                className="h-full w-full"
                title="YouTube"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                onLoad={() => {
                  // Subscribe to playback-state events so we get
                  // periodic currentTime updates via postMessage.
                  const w = ytIframeRef.current?.contentWindow;
                  if (!w) return;
                  w.postMessage(JSON.stringify({ event: 'listening' }), '*');
                  w.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
                }}
              />
            ) : hostSrc ? (
              <video src={hostSrc} controls autoPlay className="h-full w-full bg-black" />
            ) : (
              <iframe
                src={view.url}
                className="h-full w-full"
                title={view.title || view.url}
                referrerPolicy="no-referrer"
                allow="fullscreen"
              />
            )}
            </div>
            {notesOpen && view.sectionSlug && view.rowId && (
              <NotesPane
                sectionSlug={view.sectionSlug}
                rowId={view.rowId}
                initial={view.notes || ''}
              />
            )}
          </div>
          {(yt || pdf) && (
            <BookmarkDrawer
              url={view.url}
              kind={yt ? 'video' : 'pdf'}
              currentRef={() => (yt ? Math.floor(ytTimeRef.current) : pdfPage)}
              onJump={(ref) => {
                if (yt) {
                  const w = ytIframeRef.current?.contentWindow;
                  if (w) {
                    w.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [ref, true] }), '*');
                    w.postMessage(JSON.stringify({ event: 'command', func: 'playVideo' }), '*');
                  }
                } else if (pdf) {
                  setPdfPage(ref);
                }
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
