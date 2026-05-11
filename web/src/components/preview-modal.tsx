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
          <header className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-white/70 px-3 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/70">
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
            {yt && view.sectionSlug && view.rowId && (
              <button
                type="button"
                onClick={() => saveOffline('video')}
                disabled={downloading}
                title={view.driveFileId
                  ? 'Already saved — click to re-download via yt-dlp + upload to Drive'
                  : 'Download via yt-dlp + upload to Drive so this plays offline'}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" /> {downloading ? 'Saving…' : view.driveFileId ? 'Re-save' : 'Save offline'}
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
              <IframeWithFallback
                title="PDF"
                src={`/pdfjs/web/viewer.html?file=${encodeURIComponent(
                  hostSrc ?? `/api/drive/file?id=${view.driveFileId}`,
                )}#page=${pdfPage}`}
                fallbackHref={view.url}
                iframeRef={pdfIframeRef}
              />
            ) : pdf ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center text-sm text-zinc-500">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700 dark:border-zinc-700 dark:border-t-zinc-300" />
                <div>
                  Mirroring PDF to your Drive…
                  <div className="mt-1 text-xs">
                    arxiv blocks direct framing, so we copy the PDF first.
                  </div>
                </div>
                {view.sectionSlug && view.rowId && (
                  <button
                    type="button"
                    onClick={() => saveOffline('paper')}
                    disabled={downloading}
                    className="mt-2 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
                  >
                    {downloading ? 'Mirroring…' : 'Retry mirror'}
                  </button>
                )}
                <a
                  href={view.url}
                  target="_blank"
                  rel="noopener"
                  className="text-xs underline-offset-2 hover:underline"
                >
                  Open at the source instead
                </a>
              </div>
            ) : yt ? (
              <YouTubeFrame
                videoId={yt}
                start={ytResume}
                iframeRef={ytIframeRef}
                fallbackUrl={view.url}
              />
            ) : hostSrc ? (
              <video src={hostSrc} controls autoPlay className="h-full w-full bg-black" />
            ) : (
              <IframeWithFallback
                title={view.title || view.url}
                src={view.url}
                fallbackHref={view.url}
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

/** Wraps an iframe with a load watchdog. If the iframe hasn't fired
 * `onLoad` within ~6 seconds (long enough for a slow PDF), it's
 * assumed something blocked it (X-Frame-Options, network 404,
 * Drive permission, …) and a clear in-modal fallback is shown
 * instead of leaving the user staring at Chrome's generic
 * "This page couldn't load" error inside the frame. */
function IframeWithFallback({
  title, src, fallbackHref, iframeRef,
}: {
  title: string;
  src: string;
  fallbackHref?: string;
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  const [loaded, setLoaded] = useState(false);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setStuck(false);
    const t = setTimeout(() => { if (!loaded) setStuck(true); }, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef as React.RefObject<HTMLIFrameElement>}
        src={src}
        className="h-full w-full"
        title={title}
        referrerPolicy="no-referrer"
        allow="fullscreen"
        onLoad={() => { setLoaded(true); setStuck(false); }}
      />
      {stuck && !loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50/95 p-6 text-center text-sm dark:bg-zinc-950/95">
          <strong>Couldn&rsquo;t load the preview.</strong>
          <p className="max-w-md text-xs text-zinc-500">
            The page took too long or refused to embed. Try opening it in a new tab.
          </p>
          {fallbackHref && (
            <a
              href={fallbackHref}
              target="_blank"
              rel="noopener"
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
            >
              Open in new tab
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** YouTube embed with the same fallback pattern, plus the IFrame-API
 * postMessage handshake the rest of the modal depends on for resume
 * positions + bookmark seek. */
function YouTubeFrame({
  videoId, start, iframeRef, fallbackUrl,
}: {
  videoId: string;
  start: number;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  fallbackUrl: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setStuck(false);
    const t = setTimeout(() => { if (!loaded) setStuck(true); }, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef as React.RefObject<HTMLIFrameElement>}
        src={`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&enablejsapi=1&start=${start}&origin=${encodeURIComponent(origin)}`}
        className="h-full w-full"
        title="YouTube"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        onLoad={() => {
          setLoaded(true);
          setStuck(false);
          const w = iframeRef.current?.contentWindow;
          if (!w) return;
          w.postMessage(JSON.stringify({ event: 'listening' }), '*');
          w.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
        }}
      />
      {stuck && !loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50/95 p-6 text-center text-sm dark:bg-zinc-950/95">
          <strong>This video can&rsquo;t be embedded.</strong>
          <p className="max-w-md text-xs text-zinc-500">
            The uploader disabled playback on third-party sites, or the embed timed out.
          </p>
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noopener"
            className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
          >
            Open on YouTube
          </a>
        </div>
      )}
    </div>
  );
}
