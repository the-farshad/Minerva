/* Minerva — smart URL import.
 *
 * Recognises three kinds of inputs and fetches metadata client-side:
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

    // YouTube next.
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
    doi: doiLookup,
    generic: genericLookup
  };
})();
