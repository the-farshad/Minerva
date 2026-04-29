/* Minerva — iCal feed via Drive.
 *
 * Generates an .ics file from the user's tasks tab (rows with a `due` date,
 * status != done), uploads it to Drive under the user's own account, and
 * makes it world-readable so Apple/Google Calendar can subscribe to the
 * resulting public URL. drive.file scope is sufficient because the .ics
 * file is created by this app.
 *
 * Update flow: call Minerva.ical.publish(token) to upsert the file with the
 * latest tasks. Returns { fileId, url, count }.
 */
(function () {
  'use strict';

  var FILE_NAME = 'Minerva tasks.ics';
  var MIME = 'text/calendar';

  // ---- ICS string generation ------------------------------------------

  function pad(n) { return String(n).padStart(2, '0'); }

  function nowStamp() {
    var d = new Date();
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) + 'Z';
  }

  function dtDateOnly(s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return m[1] + m[2] + m[3];
  }

  function dtFull(s) {
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) + '00Z';
  }

  function escapeIcsText(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  // Fold long lines per RFC 5545 (75-octet rule, soft-wrap with CRLF + space).
  function fold(line) {
    if (line.length <= 75) return line;
    var out = line.slice(0, 75);
    var rest = line.slice(75);
    while (rest.length > 74) {
      out += '\r\n ' + rest.slice(0, 74);
      rest = rest.slice(74);
    }
    if (rest.length) out += '\r\n ' + rest;
    return out;
  }

  function buildIcs(tasks, events) {
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Minerva//feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Minerva',
      'X-WR-TIMEZONE:UTC'
    ];
    var stamp = nowStamp();
    var emitted = 0;

    // Tasks → all-day or single-point events anchored on `due`.
    (tasks || []).forEach(function (r) {
      if (r._deleted) return;
      var status = String(r.status || '').toLowerCase();
      var rawDue = r.due;
      if (!rawDue) return;
      var dateOnly = dtDateOnly(rawDue);
      var full = (!dateOnly && /T/.test(String(rawDue))) ? dtFull(rawDue) : null;
      if (!dateOnly && !full) return;

      lines.push('BEGIN:VEVENT');
      lines.push(fold('UID:task-' + r.id + '@minerva'));
      lines.push('DTSTAMP:' + stamp);
      if (dateOnly) {
        lines.push('DTSTART;VALUE=DATE:' + dateOnly);
        var d = new Date(dateOnly.slice(0, 4) + '-' + dateOnly.slice(4, 6) + '-' + dateOnly.slice(6, 8) + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + 1);
        var endStr = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
        lines.push('DTEND;VALUE=DATE:' + endStr);
      } else {
        lines.push('DTSTART:' + full);
        lines.push('DTEND:' + full);
      }
      var summary = r.title || r.id;
      if (r.priority) summary = '[' + r.priority + '] ' + summary;
      lines.push(fold('SUMMARY:' + escapeIcsText(summary)));
      var desc = [];
      if (r.notes) desc.push(r.notes);
      if (r.link) desc.push('Link: ' + r.link);
      if (r.project) desc.push('Project: ' + r.project);
      if (desc.length) lines.push(fold('DESCRIPTION:' + escapeIcsText(desc.join('\n'))));
      lines.push('STATUS:' + (status === 'done' ? 'COMPLETED' : 'CONFIRMED'));
      if (status === 'done') lines.push('PERCENT-COMPLETE:100');
      lines.push('END:VEVENT');
      emitted++;
    });

    // Events → real time-bracketed VEVENTs.
    (events || []).forEach(function (r) {
      if (r._deleted) return;
      if (!r.start || !r.end) return;
      var startFull = dtFull(r.start);
      var endFull = dtFull(r.end);
      if (!startFull || !endFull) return;
      lines.push('BEGIN:VEVENT');
      lines.push(fold('UID:event-' + r.id + '@minerva'));
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART:' + startFull);
      lines.push('DTEND:' + endFull);
      lines.push(fold('SUMMARY:' + escapeIcsText(r.title || r.id)));
      var desc = [];
      if (r.notes) desc.push(r.notes);
      if (r.location) lines.push(fold('LOCATION:' + escapeIcsText(r.location)));
      if (desc.length) lines.push(fold('DESCRIPTION:' + escapeIcsText(desc.join('\n'))));
      lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
      emitted++;
    });

    lines.push('END:VCALENDAR');
    return { ics: lines.join('\r\n') + '\r\n', count: emitted };
  }

  // ---- Drive operations ------------------------------------------------

  function authedFetch(token, url, init) {
    init = init || {};
    init.headers = Object.assign({}, init.headers || {}, {
      Authorization: 'Bearer ' + token
    });
    return fetch(url, init).then(async function (resp) {
      if (!resp.ok) {
        var text = await resp.text();
        throw new Error('Drive ' + resp.status + ': ' + text.slice(0, 300));
      }
      return resp;
    });
  }

  async function findFile(token) {
    var q = "name='" + FILE_NAME + "' and mimeType='" + MIME + "' and trashed=false";
    var url = 'https://www.googleapis.com/drive/v3/files' +
              '?q=' + encodeURIComponent(q) +
              '&fields=' + encodeURIComponent('files(id,name,webViewLink)');
    var resp = await authedFetch(token, url, { method: 'GET' });
    var data = await resp.json();
    return (data.files && data.files[0]) || null;
  }

  function multipartBody(metadata, content, mimeType) {
    var boundary = 'minerva-boundary-' + Date.now();
    var body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mimeType + '\r\n\r\n' +
      content + '\r\n' +
      '--' + boundary + '--';
    return { body: body, contentType: 'multipart/related; boundary=' + boundary };
  }

  async function uploadFile(token, existingId, ics) {
    var metadata = { name: FILE_NAME, mimeType: MIME };
    if (!existingId) metadata.description = 'Minerva tasks calendar feed (auto-generated, safe to share publicly).';
    var mp = multipartBody(metadata, ics, MIME);
    var url, method;
    if (existingId) {
      url = 'https://www.googleapis.com/upload/drive/v3/files/' + existingId + '?uploadType=multipart&fields=id,webViewLink';
      method = 'PATCH';
    } else {
      url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
      method = 'POST';
    }
    var resp = await authedFetch(token, url, {
      method: method,
      headers: { 'Content-Type': mp.contentType },
      body: mp.body
    });
    return resp.json();
  }

  async function makeWorldReadable(token, fileId) {
    // Idempotent: re-creating an existing 'anyone:reader' permission returns 200.
    var url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '/permissions?fields=id';
    var resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false })
    });
    // If permission already exists, Drive may 200 or 400. Either is OK for our purposes.
    if (!resp.ok && resp.status !== 400) {
      var text = await resp.text();
      throw new Error('Permission ' + resp.status + ': ' + text.slice(0, 300));
    }
  }

  function publicDownloadUrl(fileId) {
    return 'https://drive.google.com/uc?id=' + encodeURIComponent(fileId) + '&export=download';
  }

  function webcalUrl(fileId) {
    return 'webcal://drive.google.com/uc?id=' + encodeURIComponent(fileId) + '&export=download';
  }

  // ---- public entry ----

  async function publish(token) {
    var tasks = await Minerva.db.getAllRows('tasks').catch(function () { return []; });
    var events = await Minerva.db.getAllRows('events').catch(function () { return []; });
    var built = buildIcs(tasks || [], events || []);

    var existing = await findFile(token);
    var resp = await uploadFile(token, existing && existing.id, built.ics);
    var fileId = resp.id || (existing && existing.id);
    if (!fileId) throw new Error('Drive returned no file id.');

    try { await makeWorldReadable(token, fileId); } catch (e) { /* ignore — file may already be public */ }

    return {
      fileId: fileId,
      count: built.count,
      url: publicDownloadUrl(fileId),
      webcal: webcalUrl(fileId)
    };
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.ical = {
    publish: publish,
    buildIcs: buildIcs
  };
})();
