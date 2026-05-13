'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { Bell, BellOff, Send, Check } from 'lucide-react';

/**
 * Browser Notifications API card. Permission is OS-level so we
 * can't query it without prompting the user, but we CAN read
 * `Notification.permission` (granted / denied / default). The
 * card shows whether notifications are currently allowed by the
 * browser AND whether Minerva's per-user toggle is on, plus a
 * Test button that fires a sample Notification immediately.
 *
 * The actual hook-up to mutation events (SSE row.created etc.)
 * lives in the SSE event-bus client subscriber; this card just
 * controls whether that subscriber decides to surface a
 * Notification or stay silent.
 */
const ENABLED_KEY = 'minerva.v2.browserNotifications';

export function NotificationsCard() {
  const [permission, setPermission] = useState<'default' | 'granted' | 'denied' | 'unsupported'>('default');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission as 'default' | 'granted' | 'denied');
    try { setEnabled(localStorage.getItem(ENABLED_KEY) === '1'); }
    catch { /* no localStorage in private mode */ }
  }, []);

  async function ensurePermission(): Promise<boolean> {
    if (permission === 'granted') return true;
    if (permission === 'denied' || permission === 'unsupported') return false;
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result as 'default' | 'granted' | 'denied');
      return result === 'granted';
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (!enabled) {
      const ok = await ensurePermission();
      if (!ok) {
        if (permission === 'denied') {
          notify.error("Notifications are blocked at the browser level — re-enable them in the site settings (lock icon in the URL bar).");
        }
        return;
      }
    }
    const next = !enabled;
    setEnabled(next);
    try { localStorage.setItem(ENABLED_KEY, next ? '1' : '0'); }
    catch { /* tolerate */ }
    toast.success(next ? 'Browser notifications enabled.' : 'Browser notifications paused.');
  }

  async function test() {
    if (permission === 'unsupported') {
      notify.error("This browser doesn't support the Notifications API.");
      return;
    }
    const ok = await ensurePermission();
    if (!ok) {
      if (permission === 'denied') {
        notify.error("Notifications are blocked at the browser level.");
      }
      return;
    }
    try {
      const n = new Notification('Minerva — test', {
        body: 'Browser notifications are working. You\'ll see one of these whenever Minerva fires a server-side event you care about.',
        icon: '/icon.svg',
        tag: 'minerva-test',
      });
      // Auto-close after 5 s so they don't pile up during testing.
      setTimeout(() => { try { n.close(); } catch { /* tolerate */ } }, 5000);
      toast.success('Test notification fired.');
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  const statusLabel = (() => {
    if (permission === 'unsupported') return 'Not supported';
    if (permission === 'granted') return enabled ? 'On' : 'Allowed (paused)';
    if (permission === 'denied') return 'Blocked';
    return 'Off';
  })();

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        {enabled && permission === 'granted'
          ? <Bell className="h-4 w-4 text-zinc-500" />
          : <BellOff className="h-4 w-4 text-zinc-500" />}
        <strong className="text-sm">Browser notifications</strong>
        <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${
          permission === 'granted' && enabled
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
            : permission === 'denied'
              ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
              : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
        }`}>{statusLabel}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Local OS-level pings via the browser&rsquo;s Notification API — no server
        push, no extra services. Fires when Minerva sees a row update / save-
        offline finish / poll response while the tab is in the background.
        Permission is per-domain; granting it here doesn&rsquo;t add Minerva to
        your OS notification settings until you actually accept the prompt.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={busy || permission === 'unsupported' || permission === 'denied'}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {enabled ? <><BellOff className="h-3 w-3" /> Pause</> : <><Check className="h-3 w-3" /> Enable</>}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={busy || permission === 'unsupported'}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Send className="h-3 w-3" /> Send test
        </button>
      </div>

      {permission === 'denied' && (
        <p className="mt-2 text-[10px] text-red-600 dark:text-red-400">
          Your browser is blocking notifications for this site. Click the lock icon
          in the URL bar → Site settings → Notifications → Allow, then reload.
        </p>
      )}
    </div>
  );
}
