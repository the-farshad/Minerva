'use client';

/**
 * Settings panel: pick a public username + control whether other
 * users can find you. Sharing Phase 1 — the foundation that user
 * search and share-with-recipient flows build on.
 *
 * The username field has client-side validation that mirrors the
 * server rule (3-24 chars, [a-z0-9-], starts with a letter), so
 * the user sees the constraint before submitting. The save button
 * goes through PATCH /api/users/me; uniqueness is checked
 * server-side and surfaces here as a toast.
 */
import { useEffect, useState } from 'react';
import { AtSign, Check, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';

const USERNAME_RE = /^[a-z][a-z0-9-]{2,23}$/;

type Profile = {
  username: string | null;
  discoverable: boolean;
};

export function PublicProfileCard() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile>({ username: null, discoverable: true });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/users/me', { cache: 'no-store' });
        if (!r.ok) throw new Error(`load: ${r.status}`);
        const j = (await r.json()) as Profile;
        setProfile({ username: j.username ?? null, discoverable: !!j.discoverable });
        setDraft(j.username ?? '');
      } catch (e) {
        notify.error('Profile load failed: ' + (e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Live validation message for the draft. Matches the server
  // regex so the user gets the same feedback either side.
  const cleaned = draft.trim().toLowerCase();
  const validationError = !cleaned
    ? null
    : USERNAME_RE.test(cleaned)
      ? null
      : '3–24 chars, lowercase letters / digits / hyphens, must start with a letter.';
  const dirty = cleaned !== (profile.username ?? '').toLowerCase();

  async function saveUsername() {
    if (!cleaned) return;
    if (validationError) return;
    setSaving(true);
    try {
      const r = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleaned }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; username?: string | null };
      if (!r.ok) throw new Error(j.error || `save: ${r.status}`);
      setProfile((p) => ({ ...p, username: j.username ?? cleaned }));
      toast.success(`Username saved as @${cleaned}.`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleDiscoverable(next: boolean) {
    // Optimistic flip — revert on error so the toggle never lies.
    setProfile((p) => ({ ...p, discoverable: next }));
    try {
      const r = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoverable: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `save: ${r.status}`);
      }
      toast.success(next ? 'Others can find you by username.' : 'Hidden from user search.');
    } catch (e) {
      setProfile((p) => ({ ...p, discoverable: !next }));
      notify.error((e as Error).message);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <AtSign className="h-4 w-4" /> Public profile
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Pick a username so other Minerva users can find you when sharing playlists / papers / notes. Visibility is opt-in per share — picking a username doesn't expose anything else automatically.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-1 min-w-[12rem] items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
          <span className="text-zinc-400">@</span>
          <input
            type="text"
            value={draft}
            disabled={loading || saving}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="your-handle"
            className="flex-1 bg-transparent outline-none disabled:opacity-50"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={24}
          />
        </label>
        <button
          type="button"
          onClick={() => void saveUsername()}
          disabled={loading || saving || !!validationError || !dirty || !cleaned}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-40 dark:bg-white dark:text-zinc-900"
        >
          <Check className="h-3.5 w-3.5" /> Save
        </button>
      </div>
      {validationError && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{validationError}</p>
      )}
      {!validationError && profile.username && (
        <p className="mt-2 text-xs text-zinc-500">
          Your handle: <strong>@{profile.username}</strong>
        </p>
      )}

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={profile.discoverable}
          disabled={loading}
          onChange={(e) => void toggleDiscoverable(e.target.checked)}
          className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
        />
        <span className="inline-flex items-center gap-1.5">
          {profile.discoverable
            ? <><Eye className="h-3.5 w-3.5 text-zinc-500" /> Let other users find me by username</>
            : <><EyeOff className="h-3.5 w-3.5 text-zinc-500" /> Hidden from user search</>}
        </span>
      </label>
    </div>
  );
}
