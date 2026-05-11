'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ExternalLink, Download, Save, FileCheck2 } from 'lucide-react';
import { toast } from 'sonner';
import { BookmarkDrawer } from './bookmark-drawer';
import { NotesPane } from './notes-pane';
import { readPref, writePref } from '@/lib/prefs';
import { StickyNote } from 'lucide-react';
import { localMirror } from '@/lib/local-mirror';

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
  const [savingAnnot, setSavingAnnot] = useState(false);
  const pdfIframeRef = useRef<HTMLIFrameElement>(null);
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

  // Wire the preview modal into the browser history stack so the
  // Back button closes the overlay instead of navigating off the
  // section. We push a sentinel state when the modal opens, and
  // when popstate fires (Back pressed), we just close the modal.
  useEffect(() => {
    if (!open) return;
    history.pushState({ minervaPreview: true }, '');
    function onPop() { setOpen(false); }
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // If the modal closes for any reason other than a pop event,
      // pop our sentinel ourselves so we don't leak a history entry.
      if (history.state && (history.state as { minervaPreview?: boolean }).minervaPreview) {
        history.back();
      }
    };
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

  async function mirrorToLocal(
    kind: 'video' | 'paper',
    fileId: string,
    filename: string,
    sectionSlug: string,
    rowId: string,
  ) {
    if (!localMirror.supported()) return;
    const handle = await localMirror.handle();
    if (!handle) return;
    try {
      const r = await fetch(`/api/drive/file?id=${encodeURIComponent(fileId)}`);
      if (!r.ok) return;
      const blob = await r.blob();
      const folder = kind === 'video' ? 'videos' : 'papers';
      const marker = await localMirror.save(folder, filename, blob);
      if (!marker) return;
      await fetch(`/api/sections/${sectionSlug}/rows/${rowId}/mark-offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker }),
      });
      toast.success('Also mirrored to local folder.');
    } catch { /* tolerate */ }
  }

  async function saveAnnotations() {
    if (!view || !view.sectionSlug || !view.rowId || savingAnnot) return;
    const iframe = pdfIframeRef.current;
    interface PdfViewerApp {
      pdfDocument?: { saveDocument?: () => Promise<Uint8Array> };
    }
    const w = iframe?.contentWindow as (Window & { PDFViewerApplication?: PdfViewerApp }) | null;
    const app = w?.PDFViewerApplication;
    if (!app?.pdfDocument?.saveDocument) {
      toast.error('PDF viewer not ready yet — wait a beat and retry.');
      return;
    }
    setSavingAnnot(true);
    toast.info('Saving annotations to Drive…');
    try {
      const bytes = await app.pdfDocument.saveDocument();
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
      const stem = (view.title || 'paper').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
      const filename = `${stem}.annotated.pdf`;
      const fd = new FormData();
      fd.append('file', blob, filename);
      fd.append('name', filename);
      const up = await fetch('/api/drive/upload', { method: 'POST', body: fd });
      const upJson = await up.json();
      if (!up.ok) throw new Error(upJson.error || `upload: ${up.status}`);
      // Point the row at the new Drive copy.
      await fetch(`/api/sections/${view.sectionSlug}/rows/${view.rowId}/mark-offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker: `drive:${upJson.fileId}` }),
      });
      setView((prev) => (prev ? { ...prev, driveFileId: upJson.fileId } : prev));
      // Mirror locally too if the user opted in.
      if (view.sectionSlug && view.rowId) {
        mirrorToLocal('paper', upJson.fileId, filename, view.sectionSlug, view.rowId);
      }
      toast.success('Annotations saved.');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingAnnot(false);
    }
  }

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
      if (!j.skipped && j.fileId && j.filename && view.sectionSlug && view.rowId) {
        mirrorToLocal(kind, j.fileId, j.filename, view.sectionSlug, view.rowId);
      }
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
        if (!j.skipped && j.fileId && j.filename && v.sectionSlug && v.rowId) {
          mirrorToLocal('paper', j.fileId, j.filename, v.sectionSlug, v.rowId);
        }
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
            {pdf && view.driveFileId && view.sectionSlug && view.rowId && (
              <button
                type="button"
                onClick={saveAnnotations}
                disabled={savingAnnot}
                title="Save the current PDF, including highlights / sticky notes / ink, back to Drive"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <FileCheck2 className="h-3.5 w-3.5" /> {savingAnnot ? 'Saving…' : 'Save annotations'}
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
                ref={pdfIframeRef}
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
