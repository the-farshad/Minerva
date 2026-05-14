#!/usr/bin/env node
/**
 * Minerva local-worker for YouTube downloads.
 *
 *   $ MINERVA_BASE=https://minerva.thefarshad.com \
 *     WORKER_SECRET=... \
 *     node tools/yt-worker.js
 *
 * Polls the droplet's /api/worker/jobs/next endpoint, runs yt-dlp on
 * the local machine (residential IP — sidesteps the DigitalOcean
 * anti-bot block), uploads the resulting bytes directly to the
 * user's Drive using a short-lived access token the droplet mints
 * fresh per claim, and finally POSTs the new Drive fileId back to
 * /api/worker/jobs/:id/complete which patches the row's offline
 * marker + fires an SSE row.updated so every open tab refreshes.
 *
 * Prerequisites on the worker host:
 *   - Node 18+ (built-in fetch, FormData, Blob)
 *   - yt-dlp on PATH (pip install --upgrade --pre yt-dlp; ffmpeg)
 *   - Optional: tailscale / zerotier / ssh-reverse-tunnel if the
 *     droplet isn't publicly reachable (most are).
 *
 * Environment:
 *   MINERVA_BASE          required — https://<your-host>
 *   WORKER_SECRET         required — must match droplet's env
 *   WORKER_POLL_INTERVAL  optional — default 5000 (ms)
 *   WORKER_TMPDIR         optional — default OS tmpdir
 *   WORKER_VERBOSE        optional — '1' to log every poll
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const BASE = (process.env.MINERVA_BASE || '').replace(/\/+$/, '');
const SECRET = process.env.WORKER_SECRET || '';
const POLL_INTERVAL = Number(process.env.WORKER_POLL_INTERVAL) || 5000;
const TMPDIR = process.env.WORKER_TMPDIR || os.tmpdir();
const VERBOSE = process.env.WORKER_VERBOSE === '1';

if (!BASE || !SECRET) {
  console.error('Missing required env: MINERVA_BASE and WORKER_SECRET.');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
const vlog = (...args) => { if (VERBOSE) log(...args); };

function authedFetch(pathRel, init = {}) {
  return fetch(`${BASE}${pathRel}`, {
    ...init,
    headers: { ...(init.headers || {}), 'X-Worker-Secret': SECRET },
  });
}

async function runYtDlp(url, format, quality, outdir) {
  // Translate the API's `format`/`quality` shape into yt-dlp flags.
  // IMPORTANT: do NOT constrain the video stream to `[ext=mp4]`.
  // YouTube only publishes h264/mp4 up to ~1080p (often only 720p);
  // every resolution above that — and frequently 1080p itself — is
  // VP9 or AV1 in a webm container. An `[ext=mp4]` filter therefore
  // silently caps the download at 720p/1080p. We select the best
  // stream regardless of codec and let `--merge-output-format mp4`
  // remux it; m4a audio is still *preferred* (clean mp4 mux) but
  // not required.
  const isAudio = quality === 'audio';
  const fmtSelector = isAudio
    ? 'bestaudio/best'
    : (quality && quality !== 'best'
      ? `bv*[height<=${quality}]+ba[ext=m4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]`
      : 'bv*+ba[ext=m4a]/bv*+ba/b');
  const args = [
    '-f', fmtSelector,
    '--merge-output-format', isAudio ? 'mp3' : 'mp4',
    '--no-playlist',
    '-o', path.join(outdir, '%(id)s.%(ext)s'),
    '--print-json',
    '--no-progress',
  ];
  if (isAudio) {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K');
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 800)}`));
        return;
      }
      // Last JSON line is the info-dict for the downloaded video.
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastJson = lines.reverse().find((l) => l.startsWith('{'));
      if (!lastJson) {
        reject(new Error('yt-dlp produced no JSON info'));
        return;
      }
      let info;
      try { info = JSON.parse(lastJson); }
      catch (e) { reject(new Error(`yt-dlp JSON parse: ${e.message}`)); return; }
      resolve(info);
    });
  });
}

/** Find the actual downloaded file on disk. yt-dlp's filepath is in
 *  the info-dict but the merged output may have a different
 *  extension after ffmpeg post-processing. */
async function findOutputFile(outdir, info) {
  // Prefer _filename / filepath from info if present and on disk.
  for (const key of ['filepath', '_filename', 'filename']) {
    const p = info[key];
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  }
  // Fallback: scan the output dir for the file with this id.
  const id = info.id || '';
  if (!id) throw new Error('no id in yt-dlp info');
  const entries = await fsp.readdir(outdir);
  const match = entries.find((n) => n.startsWith(id) && /\.(mp4|mp3|m4a|webm|mkv)$/i.test(n));
  if (!match) throw new Error(`no output file matching ${id} in ${outdir}`);
  return path.join(outdir, match);
}

async function ensureMinervaFolder(accessToken) {
  // Find or create the top-level "Minerva offline" folder, then
  // the "videos" sub-folder. Mirrors the droplet's drive.ts.
  const findOrMake = async (name, parent) => {
    const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parent ? ` and '${parent}' in parents` : ''}`;
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q);
    u.searchParams.set('fields', 'files(id,name)');
    u.searchParams.set('spaces', 'drive');
    const find = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!find.ok) throw new Error(`drive find ${find.status}: ${await find.text()}`);
    const j = await find.json();
    if (j.files && j.files[0]) return j.files[0].id;
    const body = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parent) body.parents = [parent];
    const mk = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!mk.ok) throw new Error(`drive mk ${mk.status}: ${await mk.text()}`);
    const mj = await mk.json();
    return mj.id;
  };
  const root = await findOrMake('Minerva offline', null);
  return findOrMake('videos', root);
}

async function uploadToDrive(filePath, filename, mime, accessToken, parentFolderId) {
  // Multipart upload (smaller code path than resumable; fine for
  // typical video sizes up to ~1 GB which Node fetch handles).
  const bytes = await fsp.readFile(filePath);
  const metadata = { name: filename, parents: [parentFolderId] };
  const boundary = `mboundary${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([head, bytes, tail]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!r.ok) throw new Error(`drive upload ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.id;
}

async function processJob(job, accessToken) {
  const outdir = await fsp.mkdtemp(path.join(TMPDIR, 'minerva-yt-'));
  try {
    log(`job ${job.id}: yt-dlp ${job.url}`);
    const info = await runYtDlp(job.url, job.format, job.quality, outdir);
    const filePath = await findOutputFile(outdir, info);
    const ext = path.extname(filePath).replace(/^\./, '') || 'mp4';
    const stem = (info.title || info.id || 'video').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    const filename = `${stem}.${ext}`;
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : ext === 'webm' ? 'video/webm' : 'video/mp4';
    log(`job ${job.id}: uploading ${filename} (${(fs.statSync(filePath).size / 1e6).toFixed(1)} MB)`);
    const parent = await ensureMinervaFolder(accessToken);
    const driveFileId = await uploadToDrive(filePath, filename, mime, accessToken, parent);
    log(`job ${job.id}: drive ${driveFileId}`);
    return { driveFileId, filename };
  } finally {
    await fsp.rm(outdir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pollOnce() {
  const r = await authedFetch('/api/worker/jobs/next');
  if (!r.ok) {
    if (r.status === 401) throw new Error('WORKER_SECRET rejected by server (401)');
    throw new Error(`/jobs/next ${r.status}`);
  }
  const j = await r.json();
  if (!j.job) { vlog('no job'); return; }
  const job = j.job;
  const accessToken = j.driveAccessToken;
  try {
    const { driveFileId, filename } = await processJob(job, accessToken);
    const c = await authedFetch(`/api/worker/jobs/${job.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driveFileId, filename }),
    });
    if (!c.ok) log(`job ${job.id}: complete-callback ${c.status} ${await c.text()}`);
  } catch (e) {
    log(`job ${job.id}: FAILED: ${e.message}`);
    await authedFetch(`/api/worker/jobs/${job.id}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    }).catch(() => {});
  }
}

async function main() {
  log(`minerva yt-worker → ${BASE}, poll every ${POLL_INTERVAL}ms`);
  // Trap signals for a clean shutdown — Node would otherwise yank
  // an in-flight upload mid-stream and leave a half-written file
  // on Drive.
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log(`got ${sig}, draining`); shuttingDown = true; });
  }
  while (!shuttingDown) {
    try { await pollOnce(); }
    catch (e) { log('poll error:', e.message); }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  log('shutdown');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
