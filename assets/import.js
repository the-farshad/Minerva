/* Minerva — smart URL import.
 *
 * Recognises four kinds of inputs and fetches metadata client-side:
 *
 *   arXiv  — accepts a bare id like "2401.12345", an abs URL like
 *            https://arxiv.org/abs/2401.12345, or a pdf URL.
 *            Hits export.arxiv.org's Atom API (CORS-allowed) for title,
 *            authors, abstract, year, and synthesizes the matching pdf URL.
 *
 *   YouTube — any youtube.com/watch?v=… or youtu.be/… URL. Hits the
 *            public oEmbed endpoint (CORS-allowed) for title, channel
 *            (author_name), and a thumbnail URL.
 *
 *   YouTube playlist — any URL containing ?list=PL... (or watch+list).
 *            Requires a YouTube Data API v3 key in localStorage
 *            (minerva.config.v1 → youtubeApiKey). Returns kind:'playlist'
 *            with an items array of {title,channel,url,thumbnail,videoId}.
 *            Capped at MAX_PLAYLIST_ITEMS (200) for quota + UI sanity.
 *
 *   Generic — any other http(s) URL. Returns just { url } as a fallback so
 *            the caller can still create a row.
 *
 * Returns null when the input doesn't look like a URL or arXiv id at all.
 */
(function () {
  'use strict';

  function clean(s) {
    return String(s || '').trim().replace(/\s+/g, ' ');
  }

  // ---- localStorage cache for YouTube Data API responses --------------
  // Cuts quota use across repeated imports / refreshes. Three buckets:
  //   pl.<listId>     — playlist enumeration (TTL: 6 hours)
  //   dur.<videoId>   — duration string (no TTL — videos don't change length)
  //   ch.<kind>.<val> — resolved channel { uploadsPlaylistId, ... } (TTL: 30d)
  // Quota cap on individual entries (~200 KB) keeps a single huge playlist
  // from blowing up localStorage. Soft-fail on quota errors.
  var CACHE_PREFIX = 'minerva.ytcache.';
  var CACHE_TTL_PLAYLIST = 6 * 60 * 60 * 1000;
  var CACHE_TTL_CHANNEL  = 30 * 24 * 60 * 60 * 1000;
  function cacheGet(key, ttlMs) {
    var rec = cacheGetEntry(key, ttlMs);
    return rec ? rec.value : null;
  }
  function cacheGetEntry(key, ttlMs) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || typeof rec.t !== 'number') return null;
      var age = Date.now() - rec.t;
      if (ttlMs && age > ttlMs) {
        try { localStorage.removeItem(CACHE_PREFIX + key); } catch (e) {}
        return null;
      }
      return { value: rec.v, ageMs: age, ts: rec.t };
    } catch (e) { return null; }
  }
  function cachePut(key, value) {
    try {
      var s = JSON.stringify({ t: Date.now(), v: value });
      // Hard cap per entry — keeps a single absurd playlist from filling
      // the 5MB localStorage budget.
      if (s.length > 200000) return;
      localStorage.setItem(CACHE_PREFIX + key, s);
    } catch (e) { /* quota — non-fatal */ }
  }
  function cacheClear() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
      return keys.length;
    } catch (e) { return 0; }
  }

  async function arxivLookup(input) {
    var s = String(input || '');
    var m = s.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (!m) return null;
    var id = m[1];
    var resp = await fetch('https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id));
    if (!resp.ok) throw new Error('arXiv ' + resp.status);
    var xml = await resp.text();
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    var entry = doc.querySelector('entry');
    if (!entry) return null;

    var title = clean((entry.querySelector('title') || {}).textContent || '');
    var summary = clean((entry.querySelector('summary') || {}).textContent || '');
    var published = ((entry.querySelector('published') || {}).textContent || '').trim();
    var authors = Array.prototype.map.call(
      entry.querySelectorAll('author > name'),
      function (n) { return n.textContent.trim(); }
    );

    // Affiliations — first author's institution, when arXiv has it.
    var affil = '';
    var affNode = entry.querySelector('author > affiliation');
    if (affNode) affil = clean(affNode.textContent || '');

    // Subject categories — primary first, then any extras (cs.LG, math.PR…).
    // The arxiv: namespace prefix isn't always preserved by DOMParser, so
    // we walk all <category> elements and dedupe.
    var cats = [];
    var seenCat = Object.create(null);
    Array.prototype.forEach.call(entry.querySelectorAll('category'), function (n) {
      var t = (n.getAttribute('term') || '').trim();
      if (t && !seenCat[t]) { seenCat[t] = 1; cats.push(t); }
    });

    // arXiv-specific extras (journal_ref, doi, comment) live in the
    // arxiv: namespace. getElementsByTagNameNS with '*' is the most
    // reliable way to dig them out across browsers.
    function arxivField(local) {
      var nodes = entry.getElementsByTagNameNS('*', local);
      if (!nodes || !nodes.length) return '';
      return clean(nodes[0].textContent || '');
    }
    var journalRef = arxivField('journal_ref');
    var arxivDoi   = arxivField('doi');
    var comment    = arxivField('comment');

    return {
      kind: 'paper',
      title: title,
      authors: authors.join(', '),
      year: published.slice(0, 4),
      url: 'https://arxiv.org/abs/' + id,
      pdf: 'https://arxiv.org/pdf/' + id + '.pdf',
      abstract: summary,
      // Newly captured fields. Only set when arXiv actually returned them
      // — empty strings stay out of the row so manual edits aren't blown
      // away later.
      venue: journalRef || 'arXiv',
      doi: arxivDoi || '',
      tags: cats.join(', '),
      affiliation: affil,
      comment: comment
    };
  }

  // Pull the videoId from a watch / youtu.be / shorts URL. Mirrors the
  // regex preview.js / render.js use; kept local so import.js doesn't
  // depend on either.
  function videoIdOf(s) {
    var m = String(s || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&?#]+)/);
    return m ? m[1] : null;
  }

  async function youtubeLookup(input) {
    var s = String(input || '');
    if (!/youtube\.com|youtu\.be/i.test(s)) return null;
    var resp = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(s) + '&format=json');
    if (!resp.ok) throw new Error('YouTube ' + resp.status);
    var data = await resp.json();
    var author = clean(data.author_name || '');
    var out = {
      kind: 'video',
      title: clean(data.title || ''),
      // `authors` for the library preset (back-compat); `channel` for the
      // youtube tracker preset; both populated so either schema picks it up.
      authors: author,
      channel: author,
      url: s,
      thumbnail: data.thumbnail_url || ''
    };
    // If the user has set an API key, fetch duration + publish date too.
    // Free, one unit; oEmbed alone returns neither so this is the cheapest
    // way to populate those columns for single-video imports.
    var apiKey = ytApiKey();
    var vid = videoIdOf(s);
    if (apiKey && vid) {
      try {
        var details = await fetchVideoDetailsByIds([vid], apiKey);
        var d = details[vid];
        if (d) {
          if (d.duration) out.duration = d.duration;
          if (d.published) out.published = d.published;
        }
      } catch (e) { /* non-fatal */ }
    }
    return out;
  }

  // Read the user's YouTube Data API key from localStorage. Returns ''
  // when unset; callers fall back to single-video oEmbed in that case.
  function ytApiKey() {
    try {
      var raw = localStorage.getItem('minerva.config.v1');
      if (!raw) return '';
      var c = JSON.parse(raw);
      return (c && c.youtubeApiKey) ? String(c.youtubeApiKey).trim() : '';
    } catch (e) { return ''; }
  }

  // Detect a playlist URL. Matches both pure-playlist
  // (youtube.com/playlist?list=PL...) and watch+list forms.
  function youtubePlaylistId(input) {
    var s = String(input || '');
    var m = s.match(/[?&]list=([\w-]+)/);
    return m ? m[1] : null;
  }

  // Detect a YouTube channel URL. Returns one of:
  //   { kind: 'handle',    value: 'mkbhd' }       — youtube.com/@mkbhd
  //   { kind: 'channelId', value: 'UC...' }       — youtube.com/channel/UC...
  //   { kind: 'username',  value: 'somename' }    — youtube.com/user/somename
  //   { kind: 'custom',    value: 'somename' }    — youtube.com/c/somename
  // or null when input isn't a channel URL.
  function youtubeChannelTarget(input) {
    var s = String(input || '').trim();
    var m;
    if ((m = s.match(/youtube\.com\/@([^\/?#]+)/i))) return { kind: 'handle', value: m[1] };
    if ((m = s.match(/youtube\.com\/channel\/(UC[\w-]+)/i))) return { kind: 'channelId', value: m[1] };
    if ((m = s.match(/youtube\.com\/user\/([^\/?#]+)/i))) return { kind: 'username', value: m[1] };
    if ((m = s.match(/youtube\.com\/c\/([^\/?#]+)/i))) return { kind: 'custom', value: m[1] };
    return null;
  }

  // Resolve a channel target to its uploads playlist id (UU...) using the
  // Data API. Returns { uploadsPlaylistId, channelTitle, channelId } or
  // throws on API error. /c/ "custom" URLs require search.list (heavier);
  // we treat them like a handle lookup (forHandle takes the slug too) and
  // fall back to search if that fails.
  async function resolveChannelToUploads(target, apiKey) {
    if (!target || !apiKey) return null;
    var cacheKey = 'ch.' + target.kind + '.' + target.value;
    var cached = cacheGet(cacheKey, CACHE_TTL_CHANNEL);
    if (cached) return cached;
    var qs = '';
    if (target.kind === 'channelId') {
      qs = 'id=' + encodeURIComponent(target.value);
    } else if (target.kind === 'handle') {
      qs = 'forHandle=' + encodeURIComponent('@' + target.value);
    } else if (target.kind === 'username') {
      qs = 'forUsername=' + encodeURIComponent(target.value);
    } else if (target.kind === 'custom') {
      // Try forHandle first — many /c/slugs are also valid handles.
      qs = 'forHandle=' + encodeURIComponent('@' + target.value);
    }
    var url = 'https://www.googleapis.com/youtube/v3/channels'
      + '?part=snippet,contentDetails&' + qs
      + '&key=' + encodeURIComponent(apiKey);
    var resp = await fetch(url);
    if (!resp.ok) {
      var body = await resp.text().catch(function () { return ''; });
      var err;
      if (body && body.indexOf('quotaExceeded') >= 0) {
        err = 'YouTube API quota exceeded for today.';
      } else if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        err = 'YouTube API ' + resp.status + ': check your API key in Settings.';
      } else {
        err = 'YouTube API ' + resp.status + ': ' + body.slice(0, 200);
      }
      throw new Error(err);
    }
    var json = await resp.json();
    var first = (json.items || [])[0];
    if (!first) {
      // /c/ "custom" URLs don't always resolve via forHandle. Fall back
      // to search.list (100 quota units) to find the channel by name.
      if (target.kind === 'custom') {
        var sUrl = 'https://www.googleapis.com/youtube/v3/search'
          + '?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(target.value)
          + '&key=' + encodeURIComponent(apiKey);
        var sResp = await fetch(sUrl);
        if (!sResp.ok) throw new Error('YouTube channel search failed: ' + sResp.status);
        var sJson = await sResp.json();
        var sFirst = (sJson.items || [])[0];
        if (!sFirst || !sFirst.snippet) throw new Error('Channel not found: ' + target.value);
        var foundId = sFirst.snippet.channelId || (sFirst.id && sFirst.id.channelId);
        if (!foundId) throw new Error('Channel not found: ' + target.value);
        return resolveChannelToUploads({ kind: 'channelId', value: foundId }, apiKey);
      }
      throw new Error('Channel not found: ' + target.value);
    }
    var uploads = first.contentDetails
      && first.contentDetails.relatedPlaylists
      && first.contentDetails.relatedPlaylists.uploads;
    if (!uploads) throw new Error('Channel has no uploads playlist.');
    var resolved = {
      uploadsPlaylistId: uploads,
      channelTitle: clean((first.snippet && first.snippet.title) || ''),
      channelId: first.id || ''
    };
    cachePut(cacheKey, resolved);
    return resolved;
  }

  // Convenience: from a channel URL straight to a playlist enumeration
  // result. Reuses youtubePlaylistLookup() under the hood, then rewrites
  // the playlistTitle to the channel title (more meaningful than "Uploads
  // from Foo").
  async function youtubeChannelLookup(input, opts) {
    opts = opts || {};
    var apiKey = opts.apiKey || ytApiKey();
    if (!apiKey) return null;
    var target = youtubeChannelTarget(input);
    if (!target) return null;
    if (opts.noCache) {
      try { localStorage.removeItem(CACHE_PREFIX + 'ch.' + target.kind + '.' + target.value); } catch (e) {}
    }
    var resolved = await resolveChannelToUploads(target, apiKey);
    if (!resolved) return null;
    var fakePlaylistUrl = 'https://www.youtube.com/playlist?list=' + resolved.uploadsPlaylistId;
    var pl = await youtubePlaylistLookup(fakePlaylistUrl, { apiKey: apiKey, noCache: opts.noCache });
    if (!pl) return null;
    var title = resolved.channelTitle || pl.playlistTitle;
    pl.kind = 'channel';
    pl.channelId = resolved.channelId;
    pl.channelTitle = resolved.channelTitle;
    pl.playlistTitle = title;
    pl.items.forEach(function (it) { if (title) it.playlist = title; });
    return pl;
  }

  // Cap on items per playlist import. The free YouTube Data API v3 quota
  // is 10,000 units/day; playlistItems.list costs 1 unit/page (50 items),
  // so 200 items = ~4 units per import. Twenty-five imports ~ 100 units.
  // The cap is more about UI sanity than quota — adding 1000 rows in one
  // shot is rarely what the user wants.
  var MAX_PLAYLIST_ITEMS = 200;

  // Convert an ISO 8601 duration ("PT1H2M3S") to mm:ss / h:mm:ss text.
  // Empty input → ''. Used for both single-video and playlist imports.
  function isoToDuration(iso) {
    if (!iso) return '';
    var m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return '';
    var h = +(m[1] || 0), mn = +(m[2] || 0), s = +(m[3] || 0);
    if (h) return h + ':' + String(mn).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return mn + ':' + String(s).padStart(2, '0');
  }

  // videos.list for up to 50 ids per call. Returns a map keyed by videoId
  // with { duration, published }. Costs 1 quota unit per call (parts are
  // free of additional units). Per-id localStorage cache so re-importing
  // skips the API for already-known videos.
  async function fetchVideoDetailsByIds(ids, apiKey) {
    var out = {};
    if (!apiKey || !ids || !ids.length) return out;
    var miss = [];
    ids.forEach(function (id) {
      var cached = cacheGet('dur.' + id, 0);
      if (cached && typeof cached === 'object') {
        out[id] = cached;
      } else if (cached) {
        // Legacy cache entries stored just the duration string. Keep them
        // working but treat as missing the published field.
        out[id] = { duration: cached, published: '' };
      } else {
        miss.push(id);
      }
    });
    for (var off = 0; off < miss.length; off += 50) {
      var batch = miss.slice(off, off + 50);
      var url = 'https://www.googleapis.com/youtube/v3/videos'
        + '?part=contentDetails,snippet&id=' + encodeURIComponent(batch.join(','))
        + '&key=' + encodeURIComponent(apiKey);
      var resp = await fetch(url);
      if (!resp.ok) {
        // Non-fatal — details are nice-to-have. Bail this batch only.
        continue;
      }
      var json = await resp.json();
      (json.items || []).forEach(function (it) {
        var d = isoToDuration(it.contentDetails && it.contentDetails.duration);
        var p = (it.snippet && it.snippet.publishedAt) || '';
        var rec = { duration: d || '', published: p ? String(p).slice(0, 10) : '' };
        out[it.id] = rec;
        cachePut('dur.' + it.id, rec);
      });
    }
    return out;
  }

  // Backwards-compatible alias — old callers expected a flat
  // { videoId: 'mm:ss' } map. Wraps fetchVideoDetailsByIds and unwraps.
  async function fetchDurationsByIds(ids, apiKey) {
    var details = await fetchVideoDetailsByIds(ids, apiKey);
    var out = {};
    Object.keys(details).forEach(function (k) {
      if (details[k] && details[k].duration) out[k] = details[k].duration;
    });
    return out;
  }

  // playlists.list?part=snippet — one quota unit. Returns the playlist's
  // human title (used for grouping) or '' on failure.
  async function fetchPlaylistTitle(listId, apiKey) {
    if (!apiKey || !listId) return '';
    try {
      var url = 'https://www.googleapis.com/youtube/v3/playlists'
        + '?part=snippet&id=' + encodeURIComponent(listId)
        + '&key=' + encodeURIComponent(apiKey);
      var resp = await fetch(url);
      if (!resp.ok) return '';
      var json = await resp.json();
      var first = (json.items || [])[0];
      return clean((first && first.snippet && first.snippet.title) || '');
    } catch (e) { return ''; }
  }

  // Enumerate videos in a YouTube playlist via the Data API. Returns
  //   { kind:'playlist', playlistId, playlistTitle, items:[{title,channel,url,thumbnail,videoId,duration}], truncated }
  // Returns null when the input isn't a playlist URL or no API key is set.
  // Throws on API error so the caller can surface a readable message.
  async function youtubePlaylistLookup(input, opts) {
    opts = opts || {};
    var apiKey = opts.apiKey || ytApiKey();
    if (!apiKey) return null;
    var listId = youtubePlaylistId(input);
    if (!listId) return null;
    if (!opts.noCache) {
      var cachedEntry = cacheGetEntry('pl.' + listId, CACHE_TTL_PLAYLIST);
      if (cachedEntry) {
        var hit = cachedEntry.value;
        hit._cachedAgeMs = cachedEntry.ageMs;
        return hit;
      }
    }
    var out = [];
    var pageToken = '';
    var truncated = false;
    while (out.length < MAX_PLAYLIST_ITEMS) {
      var url = 'https://www.googleapis.com/youtube/v3/playlistItems'
        + '?part=snippet&maxResults=50&playlistId=' + encodeURIComponent(listId)
        + '&key=' + encodeURIComponent(apiKey)
        + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      var resp = await fetch(url);
      if (!resp.ok) {
        var body = await resp.text().catch(function () { return ''; });
        var err;
        if (body && body.indexOf('quotaExceeded') >= 0) {
          err = 'YouTube API quota exceeded for today.';
        } else if (resp.status === 404) {
          err = 'Playlist not found (or private). Make it public/unlisted, or check the URL.';
        } else if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
          err = 'YouTube API ' + resp.status + ': check your API key in Settings. ' + body.slice(0, 200);
        } else {
          err = 'YouTube API ' + resp.status + ': ' + body.slice(0, 200);
        }
        throw new Error(err);
      }
      var json = await resp.json();
      (json.items || []).forEach(function (it) {
        var sn = it.snippet || {};
        var rid = sn.resourceId || {};
        if (rid.kind !== 'youtube#video' || !rid.videoId) return;
        // Skip deleted/private placeholders — their title is "Deleted video"
        // or "Private video" and the channel is empty. Keep them out of the
        // result so the user doesn't get junk rows.
        var title = clean(sn.title || '');
        if (title === 'Deleted video' || title === 'Private video') return;
        var thumbs = sn.thumbnails || {};
        var t = thumbs.medium || thumbs.high || thumbs.default || {};
        // playlistItems gives us snippet.publishedAt (when added to the
        // playlist) and videoPublishedAt (when uploaded). Prefer the upload
        // date — that's what users mean by "when was this video published".
        var pub = sn.videoPublishedAt || sn.publishedAt || '';
        out.push({
          title: title,
          channel: clean(sn.videoOwnerChannelTitle || sn.channelTitle || ''),
          url: 'https://www.youtube.com/watch?v=' + rid.videoId,
          thumbnail: t.url || '',
          videoId: rid.videoId,
          published: pub ? String(pub).slice(0, 10) : ''
        });
      });
      if (!json.nextPageToken) break;
      if (out.length >= MAX_PLAYLIST_ITEMS) {
        // Hit the cap AND there's more — flag it so the modal/flash
        // can say "capped at 200, playlist has more".
        truncated = true;
        break;
      }
      pageToken = json.nextPageToken;
    }

    // Fan-out fetches for the playlist's title (used as a subcategory) and
    // every video's duration + publish date. Both run in parallel; failure
    // is non-fatal.
    var ids = out.map(function (x) { return x.videoId; }).filter(Boolean);
    var titlePromise = fetchPlaylistTitle(listId, apiKey);
    var detailPromise = fetchVideoDetailsByIds(ids, apiKey);
    var playlistTitle = '';
    try { playlistTitle = await titlePromise; } catch (e) { /* ignore */ }
    var details = {};
    try { details = await detailPromise; } catch (e) { /* ignore */ }
    out.forEach(function (it) {
      var d = details[it.videoId] || {};
      it.duration = d.duration || '';
      // Prefer the upload date from videos.list (more reliable than the
      // playlist snippet's videoPublishedAt, which can be stale).
      if (d.published && !it.published) it.published = d.published;
      if (playlistTitle) it.playlist = playlistTitle;
    });

    var result = {
      kind: 'playlist',
      playlistId: listId,
      playlistTitle: playlistTitle,
      items: out,
      truncated: truncated,
      max: MAX_PLAYLIST_ITEMS
    };
    cachePut('pl.' + listId, result);
    return result;
  }

  async function doiLookup(input) {
    var s = String(input || '').trim();
    // Accept bare DOI (10.xxxx/yyy), https://doi.org/10..., dx.doi.org/10..., etc.
    var m = s.match(/(10\.\d{4,9}\/[^\s]+)/);
    if (!m) return null;
    var doi = m[1].replace(/[)\.,;]+$/, '');  // strip trailing punctuation
    var resp = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi));
    if (!resp.ok) throw new Error('CrossRef ' + resp.status);
    var data = await resp.json();
    var msg = data.message || {};
    var titleArr = msg.title || [];
    var title = clean(titleArr[0] || '');
    var year = '';
    var month = '';
    var dateParts = msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0];
    if (dateParts) {
      year  = String(dateParts[0] || '');
      month = dateParts[1] ? String(dateParts[1]).padStart(2, '0') : '';
    }
    var authors = (msg.author || []).map(function (a) {
      return ((a.given || '') + ' ' + (a.family || '')).trim();
    }).filter(Boolean).join(', ');
    var abstract = clean((msg.abstract || '').replace(/<[^>]+>/g, ''));
    var pdf = '';
    (msg.link || []).forEach(function (l) {
      if (!pdf && l['content-type'] === 'application/pdf') pdf = l.URL;
    });
    var container = clean((msg['container-title'] || [])[0] || '');
    var shortContainer = clean((msg['short-container-title'] || [])[0] || '');
    // Pages may arrive as "123-145" or as numeric `page` values; CrossRef
    // is inconsistent across publishers. Stitch the most useful form.
    var pages = clean(msg.page || '');
    var volume = clean(msg.volume || '');
    var issue = clean(msg.issue || '');
    var volumeStr = volume + (issue ? '(' + issue + ')' : '');
    var publisher = clean(msg.publisher || '');
    var subjects = (msg.subject || []).map(clean).filter(Boolean);
    var issn = '';
    if (Array.isArray(msg.ISSN) && msg.ISSN.length) issn = msg.ISSN[0];
    return {
      kind: 'paper',
      title: title,
      authors: authors,
      year: year,
      month: month,
      url: 'https://doi.org/' + doi,
      pdf: pdf,
      abstract: abstract,
      venue: container || shortContainer,
      publisher: publisher,
      doi: doi,
      volume: volumeStr,
      pages: pages,
      type: clean(msg.type || ''),
      issn: issn,
      tags: subjects.join(', '),
      language: clean(msg.language || '')
    };
  }

  // Best-effort generic — most sites don't allow CORS for HTML, so this
  // can't read the page title. We just record the URL and let the user
  // fill the title in. If the target *does* allow CORS we'll grab the
  // <title>; otherwise the fetch fails silently.
  async function genericLookup(input) {
    var s = String(input || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    var out = { url: s, kind: 'article' };
    try {
      var resp = await fetch(s, { mode: 'cors' });
      if (resp.ok) {
        var html = await resp.text();
        var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (m) out.title = clean(m[1].replace(/&[a-z]+;/g, ' '));
      }
    } catch (e) { /* CORS-blocked is normal */ }
    return out;
  }

  // Best-effort metadata extraction from a local PDF File. Tries three
  // signals in priority order:
  //   1. The filename — `2401.12345.pdf`, `arxiv-…`, etc.
  //   2. PDF text content — searches the first ~256 KB for DOI / arXiv
  //      id patterns. Most modern PDFs compress streams so this hits
  //      mostly when identifiers appear in headers/footers/ToC. Still
  //      catches a surprising number of papers.
  //   3. PDF info dictionary — /Title, /Author, /Subject. Rarely as
  //      reliable as a DOI but useful as a last-resort title hint.
  // Returns { kind: 'pdf-meta', identifier, identifierKind, title?, authors? }
  // where identifierKind is 'arxiv' | 'doi' | '' so the caller can route
  // to the right lookup.
  async function pdfFileLookup(file) {
    if (!file) return null;
    var name = String(file.name || '');
    var arxivRe = /(\d{4}\.\d{4,5})(v\d+)?/i;
    var doiRe   = /\b(10\.\d{4,9}\/[^\s"<>'\\)\\]]+)/i;

    // 1. Filename — common patterns: "2401.12345.pdf", "arxiv-2401.12345.pdf"
    var fmA = name.match(arxivRe);
    if (fmA) {
      return { kind: 'pdf-meta', identifier: fmA[1], identifierKind: 'arxiv' };
    }

    // 2 + 3. Read up to 256 KB as a Latin-1 string so we can regex
    // through both content streams and the info dictionary in one pass.
    var slice = file.slice(0, 256 * 1024);
    var ab;
    try { ab = await slice.arrayBuffer(); }
    catch (e) { return null; }
    var bytes = new Uint8Array(ab);
    var text = '';
    // Latin-1 decode keeps the byte values in the resulting string,
    // which is what we want for regex matching against ASCII-ish
    // identifiers without choking on binary-stream bytes.
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);

    var ax = text.match(arxivRe);
    if (ax) {
      return { kind: 'pdf-meta', identifier: ax[1], identifierKind: 'arxiv' };
    }
    var dx = text.match(doiRe);
    if (dx) {
      var doi = dx[1].replace(/[)\.,;]+$/, '');
      return { kind: 'pdf-meta', identifier: doi, identifierKind: 'doi' };
    }

    // 3. /Title / /Author — last resort. PDF strings can be parenthesized
    // or hex-encoded; we handle the parenthesized form (most common).
    var out = { kind: 'pdf-meta', identifier: '', identifierKind: '' };
    var tMatch = text.match(/\/Title\s*\(([^)]{1,300})\)/);
    if (tMatch) out.title = clean(tMatch[1].replace(/\\([()\\])/g, '$1'));
    var aMatch = text.match(/\/Author\s*\(([^)]{1,300})\)/);
    if (aMatch) out.authors = clean(aMatch[1].replace(/\\([()\\])/g, '$1'));
    if (out.title || out.authors) return out;
    return null;
  }

  async function lookup(input, opts) {
    opts = opts || {};
    input = String(input || '').trim();
    if (!input) return null;

    // arXiv first — bare id or any arxiv URL. When the pattern matches,
    // a fetch failure is propagated as an Error rather than swallowed,
    // so callers can surface it (e.g. "arXiv API failed: …"). Otherwise
    // a transient network error degrades to a generic title-only fetch
    // and the bibliographic fields silently come back empty.
    if (/arxiv\.org|^\d{4}\.\d{4,5}/i.test(input)) {
      try {
        var ax = await arxivLookup(input);
        if (ax) return ax;
      } catch (e) {
        console.warn('[Minerva arxiv]', e);
        throw new Error('arXiv lookup failed: ' + (e && e.message || e));
      }
    }

    // DOI — bare or wrapped in doi.org. Same propagation policy as arXiv.
    if (/(?:doi\.org\/|^)10\.\d{4,9}\//i.test(input)) {
      try {
        var dx = await doiLookup(input);
        if (dx) return dx;
      } catch (e) {
        console.warn('[Minerva doi]', e);
        throw new Error('DOI lookup failed: ' + (e && e.message || e));
      }
    }

    // YouTube playlist. Both pure playlist URLs and watch+list URLs
    // match. With an API key set, we enumerate every video; without one,
    // we surface a structured "needs-key" sentinel so the URL Import
    // modal can show a clear "set up API key" CTA instead of silently
    // falling through to a single-video oEmbed (which is what made the
    // user feel that "playlist doesn't work" — it kind of did, but only
    // for one video at a time).
    if (/[?&]list=[\w-]+/.test(input)) {
      if (ytApiKey()) {
        var pl = await youtubePlaylistLookup(input, { noCache: !!opts.noCache });
        if (pl) return pl;
      } else {
        return {
          kind: 'playlist-needs-key',
          message: 'This URL contains a playlist (?list=…). To import every video automatically, set a free YouTube Data API v3 key in Settings → YouTube API key. Without it, we can only import the single video shown.',
          url: input
        };
      }
    }

    // YouTube channel — @handle, /channel/UC..., /c/, /user/.
    // Same key-required model as playlists: with a key we enumerate the
    // uploads playlist; without one, we surface a clear "needs-key" hint.
    var chTarget = youtubeChannelTarget(input);
    if (chTarget) {
      if (ytApiKey()) {
        var ch = await youtubeChannelLookup(input, { noCache: !!opts.noCache });
        if (ch) return ch;
      } else {
        return {
          kind: 'channel-needs-key',
          message: 'This is a YouTube channel URL. To import every video, set a free YouTube Data API v3 key in Settings → YouTube API key.',
          url: input
        };
      }
    }

    // YouTube single video.
    if (/youtube\.com|youtu\.be/i.test(input)) {
      try {
        var yt = await youtubeLookup(input);
        if (yt) return yt;
      } catch (e) {
        console.warn('[Minerva youtube]', e);
        // Generic URL fallback below still lets the user save the link.
      }
    }

    // Anything else — at least preserve the URL.
    if (/^https?:\/\//i.test(input)) {
      return await genericLookup(input);
    }

    return null;
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.import = {
    lookup: lookup,
    arxiv: arxivLookup,
    youtube: youtubeLookup,
    youtubePlaylist: youtubePlaylistLookup,
    youtubePlaylistId: youtubePlaylistId,
    youtubeVideoId: videoIdOf,
    youtubeChannel: youtubeChannelLookup,
    youtubeChannelTarget: youtubeChannelTarget,
    pdfFile: pdfFileLookup,
    clearYoutubeCache: cacheClear,
    fetchDurationsByIds: fetchDurationsByIds,
    fetchVideoDetailsByIds: fetchVideoDetailsByIds,
    fetchPlaylistTitle: fetchPlaylistTitle,
    isoToDuration: isoToDuration,
    ytApiKey: ytApiKey,
    doi: doiLookup,
    generic: genericLookup,
    MAX_PLAYLIST_ITEMS: MAX_PLAYLIST_ITEMS
  };
})();
