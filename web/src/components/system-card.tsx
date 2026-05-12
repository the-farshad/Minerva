'use client';

import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Copy } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Droplet disk usage panel. Pulls `GET /api/helper/disk` which the
 * Python helper answers from `shutil.disk_usage('/')`. Renders a
 * coloured bar (green <70 % / amber 70–90 / red >90) and, when
 * usage climbs past 85 %, surfaces a copy-on-click one-liner the
 * user can paste over SSH to prune unused Docker layers. We don't
 * expose `docker system prune` directly from the helper because
 * mounting `/var/run/docker.sock` widens the helper's privilege
 * footprint more than the convenience is worth.
 */

type Stats = { total: number; used: number; free: number; percent: number };

function fmt(bytes: number): string {
  if (!isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const PRUNE_CMD = 'docker system prune -af --volumes=false';

export function SystemCard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch('/api/helper/disk');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      setStats({ total: j.total, used: j.used, free: j.free, percent: j.percent });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const pct = stats?.percent ?? 0;
  const tone = pct > 90 ? 'red' : pct > 70 ? 'amber' : 'emerald';
  const toneBar = pct > 90
    ? 'bg-red-500'
    : pct > 70
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Server</h2>
      <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start gap-3">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              Droplet disk
              {stats && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  tone === 'red'
                    ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                    : tone === 'amber'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                }`}>
                  {pct}% used
                </span>
              )}
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                title="Refresh"
                className="ml-auto rounded-full p-1 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {err && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                Couldn’t reach the helper: {err}
              </p>
            )}
            {stats && (
              <>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className={`${toneBar} h-full`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                  <span>{fmt(stats.used)} used</span>
                  <span>{fmt(stats.free)} free of {fmt(stats.total)}</span>
                </div>
                {pct > 85 && (
                  <div className={`mt-3 rounded border ${tone === 'red' ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950' : 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950'} p-2 text-[11px]`}>
                    <p className="font-medium">
                      {pct > 90 ? 'Disk is critically full.' : 'Disk is filling up.'} Deploys can fail mid-pull.
                    </p>
                    <p className="mt-1 text-zinc-600 dark:text-zinc-300">
                      SSH to the droplet and run this to reclaim unused Docker layers:
                    </p>
                    <div className="mt-2 flex items-center gap-1">
                      <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono dark:bg-zinc-900">
                        {PRUNE_CMD}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            void navigator.clipboard.writeText(PRUNE_CMD);
                            toast.success('Command copied — paste it on the droplet.');
                          } catch { /* tolerate */ }
                        }}
                        title="Copy command"
                        className="rounded p-1 hover:bg-white dark:hover:bg-zinc-900"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
