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

    return {
      kind: 'paper',
      title: title,
      authors: authors.join(', '),
      year: published.slice(0, 4),
      url: 'https://arxiv.org/abs/' + id,
      pdf: 'https://arxiv.org/pdf/' + id + '.pdf',
      abstract: summary
    };
  }

  async function youtubeLookup(input) {
    var s = String(input || '');
    if (!/youtube\.com|youtu\.be/i.test(s)) return null;
    var resp = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(s) + '&format=json');
    if (!resp.ok) throw new Error('YouTube ' + resp.status);
    var data = await resp.json();
    var author = clean(data.author_name || '');
    return {
      kind: 'video',
      title: clean(data.title || ''),
      // `authors` for the library preset (back-compat); `channel` for the
      // youtube tracker preset; both populated so either schema picks it up.
      authors: author,
      channel: author,
      url: s,
      thumbnail: data.thumbnail_url || ''
    };
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

  // Cap on items per playlist import. The free YouTube Data API v3 quota
  // is 10,000 units/day; playlistItems.list costs 1 unit/page (50 items),
  // so 200 items = ~4 units per import. Twenty-five imports ~ 100 units.
  // The cap is more about UI sanity than quota — adding 1000 rows in one
  // shot is rarely what the user wants.
  var MAX_PLAYLIST_ITEMS = 200;

  // Enumerate videos in a YouTube playlist via the Data API. Returns
  //   { kind:'playlist', playlistId, items:[{title,channel,url,thumbnail,videoId}], truncated }
  // Returns null when the input isn't a playlist URL or no API key is set.
  // Throws on API error so the caller can surface a readable message.
  async function youtubePlaylistLookup(input, opts) {
    opts = opts || {};
    var apiKey = opts.apiKey || ytApiKey();
    if (!apiKey) return null;
    var listId = youtubePlaylistId(input);
    if (!listId) return null;
    var out = [];
    var pageToken = '';
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
        out.push({
          title: title,
          channel: clean(sn.videoOwnerChannelTitle || sn.channelTitle || ''),
          url: 'https://www.youtube.com/watch?v=' + rid.videoId,
          thumbnail: t.url || '',
          videoId: rid.videoId
        });
      });
      if (!json.nextPageToken) break;
      if (out.length >= MAX_PLAYLIST_ITEMS) break;
      pageToken = json.nextPageToken;
    }
    return {
      kind: 'playlist',
      playlistId: listId,
      items: out,
      truncated: out.length >= MAX_PLAYLIST_ITEMS,
      max: MAX_PLAYLIST_ITEMS
    };
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
    if (msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0]) {
      year = String(msg.issued['date-parts'][0][0] || '');
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
    return {
      kind: 'paper',
      title: title,
      authors: authors,
      year: year,
      url: 'https://doi.org/' + doi,
      pdf: pdf,
      abstract: abstract,
      venue: container
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

  async function lookup(input) {
    input = String(input || '').trim();
    if (!input) return null;

    // arXiv first — bare id or any arxiv URL.
    if (/arxiv\.org|^\d{4}\.\d{4,5}/i.test(input)) {
      try {
        var ax = await arxivLookup(input);
        if (ax) return ax;
      } catch (e) { /* fall through */ }
    }

    // DOI — bare or wrapped in doi.org.
    if (/(?:doi\.org\/|^)10\.\d{4,9}\//i.test(input)) {
      try {
        var dx = await doiLookup(input);
        if (dx) return dx;
      } catch (e) { /* fall through */ }
    }

    // YouTube playlist (only when an API key is configured). Both pure
    // playlist URLs and watch+list URLs match here; the playlist branch
    // wins over the single-video oEmbed when keyed. Errors are surfaced
    // so the user knows why the playlist didn't enumerate.
    if (/[?&]list=[\w-]+/.test(input) && ytApiKey()) {
      var pl = await youtubePlaylistLookup(input);
      if (pl) return pl;
    }

    // YouTube single video.
    if (/youtube\.com|youtu\.be/i.test(input)) {
      try {
        var yt = await youtubeLookup(input);
        if (yt) return yt;
      } catch (e) { /* fall through */ }
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
    doi: doiLookup,
    generic: genericLookup,
    MAX_PLAYLIST_ITEMS: MAX_PLAYLIST_ITEMS
  };
})();
