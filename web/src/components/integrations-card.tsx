'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Trash2, Upload, Cookie, Video, Network } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

const YT_QUALITIES: Array<{ value: string; label: string; hint?: string }> = [
  { value: 'best',  label: 'Best available', hint: 'Highest mp4 yt-dlp can fetch (default).' },
  { value: '1080',  label: '1080p cap' },
  { value: '720',   label: '720p cap', hint: 'Roughly halves the file size vs 1080p.' },
  { value: '480',   label: '480p cap' },
  { value: '360',   label: '360p cap', hint: 'Tiny files — fastest downloads, lousy quality.' },
  { value: 'audio', label: 'Audio only (mp3)', hint: 'Drops the video stream entirely.' },
];

/**
 * Settings card for server-only integrations (currently: YouTube
 * Data API). The key value is NEVER returned to the browser — the
 * GET /api/userprefs/server response is just `{ key: boolean }`, so
 * we can show a "✓ Saved" badge without re-fetching the secret. The
 * input field is empty by default; entering a value replaces the
 * stored key, and the trash button clears it.
 */
export function IntegrationsCard() {
  const [ytKeyPresent, setYtKeyPresent] = useState<boolean | null>(null);
  const [ytInput, setYtInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [cookiesStat, setCookiesStat] = useState<{ size?: number; mtime?: number; exists?: boolean } | null>(null);
  const [uploadingCookies, setUploadingCookies] = useState(false);
  const cookiesFileRef = useRef<HTMLInputElement>(null);
  const [ytQuality, setYtQuality] = useState<string>('best');
  const [savingQuality, setSavingQuality] = useState(false);
  const [relatedProvider, setRelatedProvider] = useState<string>('openalex');
  const [savingRelated, setSavingRelated] = useState(false);

  async function load() {
    try {
      const r = await fetch('/api/userprefs/server');
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as Record<string, boolean | Record<string, string>>;
      setYtKeyPresent(!!j.youtube_api_key);
      const values = (j._values as Record<string, string>) || {};
      if (values.yt_quality) setYtQuality(values.yt_quality);
      if (values.related_papers_provider) setRelatedProvider(values.related_papers_provider);
    } catch {
      setYtKeyPresent(false);
    }
    try {
      const r = await fetch('/api/helper/cookies');
      if (r.ok) setCookiesStat(await r.json());
    } catch { /* tolerate */ }
  }

  async function saveRelatedProvider(next: string) {
    setSavingRelated(true);
    try {
      const r = await fetch('/api/userprefs/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'related_papers_provider', value: next || null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || String(r.status));
      }
      setRelatedProvider(next);
      toast.success(`Related-papers source: ${next === 'semanticscholar' ? 'Semantic Scholar' : 'OpenAlex'}.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSavingRelated(false);
    }
  }

  async function saveQuality(next: string) {
    setSavingQuality(true);
    try {
      const r = await fetch('/api/userprefs/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'yt_quality', value: next || null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || String(r.status));
      }
      setYtQuality(next);
      toast.success('Default quality updated.');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSavingQuality(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function uploadCookies(text: string) {
    if (!text.trim().startsWith('# Netscape HTTP Cookie File')) {
      notify.error('That doesn\'t look like a Netscape cookies file (the first line must be `# Netscape HTTP Cookie File`).');
      return;
    }
    setUploadingCookies(true);
    try {
      const r = await fetch('/api/helper/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; size?: number; mtime?: number };
      if (!r.ok || j.ok === false) throw new Error(j.error || `cookies upload: ${r.status}`);
      setCookiesStat({ exists: true, size: j.size, mtime: j.mtime });
      toast.success(`Cookies refreshed (${j.size?.toLocaleString()} B).`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setUploadingCookies(false);
      if (cookiesFileRef.current) cookiesFileRef.current.value = '';
    }
  }

  async function save(value: string | null) {
    setSaving(true);
    try {
      const r = await fetch('/api/userprefs/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'youtube_api_key', value }),
      });
      const j = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) throw new Error(j.error || String(r.status));
      setYtKeyPresent(value !== null && value !== '');
      setYtInput('');
      toast.success(value ? 'YouTube API key saved.' : 'YouTube API key cleared.');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Integrations</h2>
      <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              YouTube Data API key
              {ytKeyPresent === true && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  <Check className="h-3 w-3" /> Saved
                </span>
              )}
              {ytKeyPresent === false && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Not set
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Enables the <span className="font-medium">Refresh metadata</span> button on
              YouTube videos (title, channel, duration, view/like counts, thumbnails,
              playlist name). The key is stored server-side and never returned to the
              browser. Get one at <a className="underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">console.cloud.google.com/apis/credentials</a>.
              Does NOT affect downloads — the Data API doesn&rsquo;t serve playable streams.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                placeholder={ytKeyPresent ? '••••••• (paste to replace)' : 'AIza…'}
                value={ytInput}
                onChange={(e) => setYtInput(e.target.value)}
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => save(ytInput.trim() || null)}
                disabled={saving || !ytInput.trim()}
                className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
              >
                {saving ? 'Saving…' : 'Save key'}
              </button>
              {ytKeyPresent && (
                <button
                  type="button"
                  onClick={() => save(null)}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-zinc-700 dark:text-red-400 dark:hover:bg-red-950"
                  title="Clear the stored API key"
                >
                  <Trash2 className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3 border-t border-zinc-100 pt-5 dark:border-zinc-800">
          <Cookie className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              YouTube cookies (yt-dlp)
              {cookiesStat?.exists && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  {cookiesStat.size?.toLocaleString()} B · updated {cookiesStat.mtime ? new Date(cookiesStat.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '?'}
                </span>
              )}
              {cookiesStat?.exists === false && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Not uploaded
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Used by yt-dlp when YouTube hits a video with &quot;Sign in to confirm you&rsquo;re not a bot.&quot;
              Export from a logged-in browser using a Netscape-format extension (e.g.{' '}
              <span className="font-mono">Get cookies.txt LOCALLY</span>) and upload the resulting
              file here. If yt-dlp still refuses a video, the helper now falls back to public
              Piped instances, so cookies aren&rsquo;t always needed.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                ref={cookiesFileRef}
                type="file"
                accept=".txt,text/plain"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const text = await f.text();
                  await uploadCookies(text);
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => cookiesFileRef.current?.click()}
                disabled={uploadingCookies}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
              >
                <Upload className="h-3 w-3" /> {uploadingCookies ? 'Uploading…' : 'Upload cookies.txt'}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3 border-t border-zinc-100 pt-5 dark:border-zinc-800">
          <Video className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              Default video quality
              {savingQuality && <span className="text-[10px] font-normal text-zinc-500">Saving…</span>}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Applied to every Save-offline that doesn&rsquo;t override. yt-dlp asks YouTube
              for the best file ≤ the height cap (and falls through if exactly that
              resolution isn&rsquo;t published — there&rsquo;s no &quot;no result&quot; failure).
              &quot;Audio only&quot; transcodes to mp3 192 kbps — handy for podcasts / lectures.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {YT_QUALITIES.map((q) => {
                const active = ytQuality === q.value;
                return (
                  <button
                    key={q.value}
                    type="button"
                    onClick={() => void saveQuality(q.value)}
                    disabled={savingQuality}
                    title={q.hint || q.label}
                    className={`rounded-lg border px-3 py-2 text-left text-xs transition disabled:opacity-50 ${active
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                      : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
                  >
                    <div className="font-medium">{q.label}</div>
                    {q.hint && (
                      <div className={`mt-0.5 line-clamp-2 text-[10px] ${active ? 'opacity-80' : 'text-zinc-500'}`}>
                        {q.hint}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3 border-t border-zinc-100 pt-5 dark:border-zinc-800">
          <Network className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              Related-papers source
              {savingRelated && <span className="text-[10px] font-normal text-zinc-500">Saving…</span>}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Backend the <span className="font-medium">Related papers</span> page uses to find
              recommendations.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {([
                {
                  value: 'openalex',
                  title: 'OpenAlex',
                  badge: 'Default',
                  desc: 'No API key needed. 100 k requests / day from the polite pool. Returns up to ~10 closely-related works per paper.',
                },
                {
                  value: 'semanticscholar',
                  title: 'Semantic Scholar',
                  badge: 'Needs key',
                  desc: 'Returns up to 100 candidates per paper. Rate-limits shared cloud IPs heavily without SEMANTIC_SCHOLAR_API_KEY in the droplet env.',
                },
              ] as const).map((opt) => {
                const active = relatedProvider === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => void saveRelatedProvider(opt.value)}
                    disabled={savingRelated}
                    className={`rounded-lg border px-3 py-2.5 text-left text-xs transition disabled:opacity-50 ${active
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                      : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{opt.title}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${active
                        ? 'bg-white/20 text-white dark:bg-zinc-900/15 dark:text-zinc-900'
                        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>
                        {opt.badge}
                      </span>
                    </div>
                    <div className={`mt-1 text-[10px] leading-snug ${active ? 'opacity-80' : 'text-zinc-500'}`}>
                      {opt.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
