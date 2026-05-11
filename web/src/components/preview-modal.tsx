'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ExternalLink, Download, Save, FileCheck2, Info, Sun, Coffee, Moon, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
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
  /** Drive fileId of the pristine snapshot taken on the first
   * annotation save. Present only after the user has edited at
   * least once; gates the "Reset to original" button. */
  originalFileId?: string;
  /** host:<path> marker if the helper has a copy on disk. */
  hostPath?: string;
  /** Row id — needed when the preview triggers a download or
   * auto-mirror that writes an offline marker back to the row. */
  rowId?: string;
  sectionSlug?: string;
  /** Current `notes` value for the row, for the side pane. */
  notes?: string;
  /** Full row.data for the "More info" pane. */
  data?: Record<string, unknown>;
};

const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/;
// Match: .pdf extension, arxiv abs/pdf URLs, and any Drive file
// link — directly-uploaded papers carry a drive.google.com/file/d/<id>
// URL, and iframing that URL hits Google's "You need access" page
// (Drive's web preview enforces browser-session auth, not the app's
// drive.file scope). Treating these as PDFs routes them through
// /api/pdf/<rowId>, which streams the bytes via our OAuth token.
const PDF_RE = /\.pdf(\?|#|$)|arxiv\.org\/(?:abs|pdf)\/|drive\.google\.com\/file\/d\//i;

function ytId(url: string) {
  const m = url.match(YT_RE);
  return m ? m[1] : null;
}
function isPdf(url: string) {
  return PDF_RE.test(url);
}
/** Resolve a paper row's URL to the actual PDF: arxiv `/abs/` →
 * `/pdf/`, otherwise return as-is. */
function pdfDirectUrl(url: string): string {
  if (/arxiv\.org\/abs\//i.test(url)) {
    return url.replace(/\/abs\//i, '/pdf/').replace(/(\.pdf)?$/i, '.pdf');
  }
  return url;
}

export function PreviewModal({
  item,
  onClose,
  onNotesSaved,
}: {
  item: PreviewItem | null;
  onClose: () => void;
  /** Called after the NotesPane successfully PATCHes the row's
   * notes. Lets the parent refresh its `rows` cache so a reopen of
   * the modal shows the just-saved value instead of the pre-edit
   * one. */
  onNotesSaved?: (rowId: string, notes: string) => void;
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
  const [infoOpen, setInfoOpen] = useState(false);
  // PDF theme — light is the default; sepia and dark are baked into
  // the viewer iframe via PDF.js's #pagecolors hash. Changing theme
  // re-keys the iframe (its `key` prop combines theme + bust), which
  // is the only way to re-render canvas pages with new colors.
  const [pdfTheme, setPdfTheme] = useState<'light' | 'sepia' | 'dark'>('light');
  const [pdfReload, setPdfReload] = useState(0);
  const [resettingPdf, setResettingPdf] = useState(false);
  useEffect(() => {
    const saved = readPref<string>('paper.theme', 'light');
    if (saved === 'sepia' || saved === 'dark' || saved === 'light') setPdfTheme(saved);
  }, []);
  // Local mirror of the item so async writes (auto-mirror, manual
  // download) can flip the modal to a freshly-uploaded Drive blob
  // without the parent re-rendering.
  const [view, setView] = useState<PreviewItem | null>(item);
  useEffect(() => { setView(item); }, [item]);
  useEffect(() => {
    if (!open && item) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Browser-Back-closes-modal — track via a ref whether we own a
  // sentinel history state. On modal open, push the sentinel and
  // attach a popstate listener that flips `open` false. On modal
  // close via X / Escape, pop the sentinel ourselves so the user's
  // history isn't littered with no-op entries. This is the version
  // of the earlier attempt that actually keeps the bookkeeping
  // straight under React StrictMode.
  const sentinelOwned = useRef(false);
  useEffect(() => {
    if (!open) return;
    history.pushState({ minervaPreview: true }, '');
    sentinelOwned.current = true;
    function onPop(e: PopStateEvent) {
      // popstate fired because the user hit Back — sentinel is
      // already gone from history; just close the modal without
      // trying to pop it again.
      sentinelOwned.current = false;
      setOpen(false);
      void e;
    }
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // X / Escape / item-changed path: pop our sentinel so the
      // history stack returns to where it was before the modal
      // opened. Guarded so we don't pop if popstate already fired.
      if (sentinelOwned.current) {
        sentinelOwned.current = false;
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

  // Paper auto-mirror on first preview-open: fire and forget so
  // the iframe can start loading the (probably-X-Frame-blocked)
  // arxiv URL while the helper grabs the PDF in the background.
  // Must live above the `if (!view) return null` early return —
  // hooks order must be stable across renders.
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

  // Auto-save annotations 4 s after the user pauses editing. PDF.js
  // exposes `pdfDocument.annotationStorage.onSetModified`, a callback
  // that fires whenever any annotation is added / moved / edited /
  // deleted. (The earlier `annotationeditorstateschanged` event we
  // tried does not exist in viewer.mjs 4.10 — `dispatch(...)` only
  // emits `annotationeditormodechanged` and `annotationeditorparamschanged`,
  // both of which fire on tool/colour switches, not on actual content
  // edits.) annotationStorage isn't populated until the document
  // finishes loading, so we hook `pagesloaded` first and wire the
  // callback then. Debounced so a single stroke isn't a Drive upload
  // per pixel.
  useEffect(() => {
    if (!view || !isPdf(view.url) || !view.rowId || !view.sectionSlug) return;
    const iframe = pdfIframeRef.current;
    if (!iframe) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let detachStorage: (() => void) | null = null;
    let detachEvent: (() => void) | null = null;
    interface AnnotationStorage {
      onSetModified: (() => void) | null;
    }
    interface PdfApp {
      initializedPromise?: Promise<void>;
      pdfDocument?: { annotationStorage?: AnnotationStorage };
      eventBus?: {
        on: (name: string, fn: () => void) => void;
        off: (name: string, fn: () => void) => void;
      };
    }
    const attach = async () => {
      if (cancelled) return;
      const w = iframe.contentWindow as (Window & { PDFViewerApplication?: PdfApp }) | null;
      const app = w?.PDFViewerApplication;
      if (!app?.initializedPromise || !app.eventBus) return;
      try { await app.initializedPromise; } catch { return; }
      if (cancelled) return;
      const wire = () => {
        const storage = app.pdfDocument?.annotationStorage;
        if (!storage) return false;
        storage.onSetModified = () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => { void saveAnnotations(); }, 4000);
        };
        detachStorage = () => { try { storage.onSetModified = null; } catch { /* tolerate */ } };
        return true;
      };
      if (!wire()) {
        const onLoaded = () => { wire(); if (detachEvent) detachEvent(); };
        app.eventBus.on('pagesloaded', onLoaded);
        detachEvent = () => app.eventBus?.off('pagesloaded', onLoaded);
      }
    };
    iframe.addEventListener('load', attach);
    void attach();
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      iframe.removeEventListener('load', attach);
      if (detachStorage) detachStorage();
      if (detachEvent) detachEvent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.url, view?.rowId, view?.sectionSlug, pdfReload]);

  if (!view) return null;

  const yt = ytId(view.url);
  const pdf = isPdf(view.url);
  const ytResume = yt ? readPref<number>(`resume.${view.url}`, 0) : 0;
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
      notify.error('PDF viewer not ready yet — wait a beat and retry.');
      return;
    }
    setSavingAnnot(true);
    try {
      const bytes = await app.pdfDocument.saveDocument();
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
      const fd = new FormData();
      fd.append('file', blob, 'annotated.pdf');
      const up = await fetch(
        `/api/sections/${view.sectionSlug}/rows/${view.rowId}/save-annotations`,
        { method: 'POST', body: fd },
      );
      const upJson = (await up.json().catch(() => ({}))) as {
        error?: string; fileId?: string; originalFileId?: string | null;
      };
      if (!up.ok) throw new Error(upJson.error || `save-annotations: ${up.status}`);
      // Same fileId as before — overwrite-in-place. Capture the
      // originalFileId from the server so the Reset button appears
      // immediately on first edit, without waiting for a refresh.
      setView((prev) => (prev ? {
        ...prev,
        originalFileId: upJson.originalFileId || prev.originalFileId,
      } : prev));
    } catch (e) {
      notify.error((e as Error).message);
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
      // Save-offline normally returns JSON. When the request runs
      // past Cloudflare's 100 s edge timeout (long yt-dlp + Drive
      // upload), Cloudflare returns its own HTML error page — and
      // .json() would throw on the `<!DOCTYPE html>` opener. Sniff
      // the content-type and translate to an actionable sentence.
      const ct = r.headers.get('Content-Type') || '';
      let j: { error?: string; fileId?: string; filename?: string; skipped?: boolean } = {};
      if (/application\/json/i.test(ct)) {
        j = await r.json().catch(() => ({}));
      } else {
        const text = await r.text().catch(() => '');
        if (/<!doctype html|<html/i.test(text)) {
          j = { error: `Edge timeout (${r.status}). yt-dlp likely ran past Cloudflare's 100 s limit — the download may still be finishing on the server. Wait ~1 min and click Save offline again; if a Drive copy landed, the preview will switch to it automatically.` };
        } else {
          j = { error: text.trim().slice(0, 400) || `save-offline: ${r.status}` };
        }
      }
      if (!r.ok) throw new Error(j.error || `save-offline: ${r.status}`);
      toast.success(j.skipped ? 'Already offline.' : 'Saved to Drive.');
      setView((prev) => (prev ? { ...prev, driveFileId: j.fileId } : prev));
      if (!j.skipped && j.fileId && j.filename && view.sectionSlug && view.rowId) {
        mirrorToLocal(kind, j.fileId, j.filename, view.sectionSlug, view.rowId);
      }
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

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
                title="Save edits now (auto-save runs 4 s after the last change anyway)"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <FileCheck2 className="h-3.5 w-3.5" /> {savingAnnot ? 'Saving…' : 'Save'}
              </button>
            )}
            {pdf && view.driveFileId && view.originalFileId && view.sectionSlug && view.rowId && (
              <button
                type="button"
                onClick={async () => {
                  if (!view.sectionSlug || !view.rowId) return;
                  if (!window.confirm('Reset this paper to the pristine original? Your annotations will be replaced.')) return;
                  setResettingPdf(true);
                  try {
                    const r = await fetch(
                      `/api/sections/${view.sectionSlug}/rows/${view.rowId}/reset-pdf`,
                      { method: 'POST' },
                    );
                    const j = (await r.json().catch(() => ({}))) as { error?: string };
                    if (!r.ok) throw new Error(j.error || `reset-pdf: ${r.status}`);
                    setPdfReload((n) => n + 1);
                  } catch (e) {
                    notify.error((e as Error).message);
                  } finally {
                    setResettingPdf(false);
                  }
                }}
                disabled={resettingPdf}
                title="Discard annotations and reload the pristine PDF from the saved snapshot"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <RotateCcw className="h-3.5 w-3.5" /> {resettingPdf ? 'Resetting…' : 'Reset'}
              </button>
            )}
            {pdf && (
              <div className="inline-flex items-center rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
                {(['light', 'sepia', 'dark'] as const).map((t) => {
                  const Icon = t === 'light' ? Sun : t === 'sepia' ? Coffee : Moon;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        if (t === pdfTheme) return;
                        setPdfTheme(t);
                        writePref('paper.theme', t);
                      }}
                      title={`${t[0].toUpperCase() + t.slice(1)} reading theme`}
                      className={`rounded-full p-1 ${pdfTheme === t ? 'bg-white shadow-sm dark:bg-zinc-950' : 'opacity-60 hover:opacity-100'}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  );
                })}
              </div>
            )}
            {view.data && Object.keys(view.data).length > 0 && (
              <button
                type="button"
                onClick={() => setInfoOpen((v) => !v)}
                title="More info"
                className={`rounded-full p-1.5 ${infoOpen ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
              >
                <Info className="h-4 w-4" />
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
            {pdf && view.rowId ? (
              /* Bundled Mozilla PDF.js viewer (same-origin under
               * /pdfjs/) — exposes PDFViewerApplication on the
               * iframe's contentWindow so the in-viewer annotation
               * editor (highlight, free-text, ink, sticky-note)
               * works AND our `Save annotations` + auto-save can
               * call `pdfDocument.saveDocument()` to round-trip
               * edits back to Drive. The `file=` param points at
               * /api/pdf/<rowId>, which streams bytes via our
               * Drive OAuth token — no upstream CORS, no nested
               * query strings. */
              <iframe
                key={`${pdfTheme}-${pdfReload}`}
                ref={pdfIframeRef}
                title="PDF"
                src={(() => {
                  const file = `/api/pdf/${view.rowId}?v=${pdfReload}`;
                  const hashParts: string[] = [`page=${pdfPage}`];
                  if (pdfTheme === 'sepia') {
                    hashParts.push('pagecolors=foreground=%235b4636,background=%23f4ecd8');
                  } else if (pdfTheme === 'dark') {
                    hashParts.push('pagecolors=foreground=%23e6e6e6,background=%231f1f1f');
                  }
                  return `/pdfjs/web/viewer.html?file=${encodeURIComponent(file)}#${hashParts.join('&')}`;
                })()}
                className="h-full w-full border-0 bg-zinc-100 dark:bg-zinc-900"
                referrerPolicy="no-referrer"
              />
            ) : pdf ? (
              <IframeWithFallback
                title="PDF"
                src={`/pdfjs/web/viewer.html?file=${encodeURIComponent(
                  hostSrc ?? (view.driveFileId ? `/api/drive/file?id=${view.driveFileId}` : view.url),
                )}#page=${pdfPage}`}
                fallbackHref={view.url}
                iframeRef={pdfIframeRef}
              />
            ) : yt && view.driveFileId ? (
              /* Offline-first: once the video has been downloaded
               * via yt-dlp + mirrored to Drive, play the local MP4
               * instead of the YouTube embed. Drive auth is handled
               * server-side; the <video> element sees plain
               * same-origin bytes with Range support. */
              <video
                src={`/api/drive/file?id=${encodeURIComponent(view.driveFileId)}`}
                controls
                autoPlay
                className="h-full w-full bg-black"
              />
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
            {infoOpen && view.data && (
              <aside className="flex h-full w-72 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <div className="border-b border-zinc-200 px-3 py-2 text-xs font-semibold dark:border-zinc-800">Info</div>
                <dl className="flex-1 space-y-2 overflow-auto p-3 text-xs">
                  {Object.entries(view.data)
                    .filter(([k, v]) =>
                      v != null && v !== '' &&
                      !k.startsWith('_') &&
                      !['offline', 'notes', 'thumbnail'].includes(k))
                    .map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[5.5rem_1fr] gap-2">
                        <dt className="text-zinc-500">{k}</dt>
                        <dd className="break-words font-medium text-zinc-700 dark:text-zinc-200">
                          {String(v).slice(0, 600)}
                        </dd>
                      </div>
                    ))}
                </dl>
              </aside>
            )}
            {notesOpen && view.sectionSlug && view.rowId && (
              <NotesPane
                sectionSlug={view.sectionSlug}
                rowId={view.rowId}
                initial={view.notes || ''}
                onSaved={(next) => {
                  setView((prev) => (prev ? { ...prev, notes: next } : prev));
                  onNotesSaved?.(view.rowId!, next);
                }}
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
  const [showDebug, setShowDebug] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setStuck(false);
    const t = setTimeout(() => { if (!loaded) setStuck(true); }, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        onClick={() => setShowDebug((v) => !v)}
        className="absolute right-2 top-2 z-10 rounded-full bg-zinc-900/70 px-2 py-0.5 font-mono text-[10px] text-white backdrop-blur"
        title="Click to toggle iframe URL — useful when it's not loading"
      >
        {showDebug ? '×' : 'src'}
      </button>
      {showDebug && (
        <div
          onClick={async (e) => {
            e.stopPropagation();
            try { await navigator.clipboard.writeText(src); } catch { /* tolerate */ }
          }}
          className="absolute left-2 right-12 top-2 z-10 cursor-copy break-all rounded bg-zinc-900/70 px-2 py-1 font-mono text-[10px] text-white backdrop-blur"
          title="Click to copy"
        >
          {src}
        </div>
      )}
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
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-zinc-50/95 p-6 text-center text-sm dark:bg-zinc-950/95">
          <strong>Couldn&rsquo;t load the preview.</strong>
          <p className="max-w-md text-xs text-zinc-500">
            The page took too long or refused to embed. Click the URL to copy it.
          </p>
          <code
            role="button"
            tabIndex={0}
            onClick={() => { try { void navigator.clipboard.writeText(src); toast.success('URL copied'); } catch { /* tolerate */ } }}
            className="max-w-md cursor-copy break-all rounded bg-zinc-100 px-2 py-1 text-[10px] text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            title="Click to copy"
          >{src}</code>
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
  const [showDebug, setShowDebug] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setStuck(false);
    const t = setTimeout(() => { if (!loaded) setStuck(true); }, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const ytSrc = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&enablejsapi=1&start=${start}&origin=${encodeURIComponent(origin)}`;
  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        onClick={() => setShowDebug((v) => !v)}
        className="absolute right-2 top-2 z-10 rounded-full bg-zinc-900/70 px-2 py-0.5 font-mono text-[10px] text-white backdrop-blur"
        title="Click to toggle iframe URL"
      >
        {showDebug ? '×' : 'src'}
      </button>
      {showDebug && (
        <div
          onClick={async (e) => {
            e.stopPropagation();
            try { await navigator.clipboard.writeText(ytSrc); } catch { /* tolerate */ }
          }}
          className="absolute left-2 right-12 top-2 z-10 cursor-copy break-all rounded bg-zinc-900/70 px-2 py-1 font-mono text-[10px] text-white backdrop-blur"
        >
          {ytSrc}
        </div>
      )}
      <iframe
        ref={iframeRef as React.RefObject<HTMLIFrameElement>}
        src={ytSrc}
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
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-zinc-50/95 p-6 text-center text-sm dark:bg-zinc-950/95">
          <strong>This video can&rsquo;t be embedded.</strong>
          <p className="max-w-md text-xs text-zinc-500">
            The uploader disabled playback on third-party sites, the embed
            timed out, or YouTube returned an error inside the iframe.
            Click the URL to copy it.
          </p>
          <code
            role="button"
            tabIndex={0}
            onClick={() => { try { void navigator.clipboard.writeText(fallbackUrl); toast.success('URL copied'); } catch { /* tolerate */ } }}
            className="max-w-md cursor-copy break-all rounded bg-zinc-100 px-2 py-1 text-[10px] text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            title="Click to copy"
          >{fallbackUrl}</code>
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
