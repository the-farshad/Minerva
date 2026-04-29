/* Minerva — When-to-meet group availability poll.
 *
 * Three URL shapes, all served by the static site (no backend):
 *
 *   #/meet/new                — organizer composes the poll
 *   #/meet/<pollToken>        — participant marks availability and copies
 *                                a response token to send back
 *   #/meet/<pollToken>/<r1>;<r2>;...
 *                              — organizer's aggregate view; concatenates
 *                                response tokens with semicolons in the URL
 *
 * Tokens are base64url-utf8 of compact JSON. The poll defines days (date
 * strings) and time slots (HH:MM steps). Responses are bitfield arrays of
 * day×slot booleans, plus a name.
 *
 * Public surface on Minerva.meet:
 *   build({ title, days, fromHour, toHour, slotMin, organizer? })
 *     → poll object with .slots array
 *   encodePoll(poll), decodePoll(token)
 *   encodeResponse(resp), decodeResponse(token)
 *   slotIso(poll, dayIdx, slotIdx) → ISO datetime for that cell
 *   bitsToYes(poll, bits) / yesToBits(poll, yesIdx)
 */
(function () {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }

  function rangeDays(startISO, endISO) {
    var s = new Date(startISO + 'T00:00:00');
    var e = new Date(endISO + 'T00:00:00');
    var out = [];
    var d = new Date(s);
    while (d <= e) {
      out.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function rangeSlots(fromHour, toHour, slotMin) {
    var out = [];
    var minutes = fromHour * 60;
    var endMinutes = toHour * 60;
    while (minutes < endMinutes) {
      out.push(pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60));
      minutes += slotMin;
    }
    return out;
  }

  function build(opts) {
    var days = (opts.start && opts.end) ? rangeDays(opts.start, opts.end)
      : (Array.isArray(opts.days) ? opts.days : []);
    var slots = rangeSlots(opts.fromHour || 9, opts.toHour || 18, opts.slotMin || 30);
    return {
      v: 1,
      t: opts.title || '',
      o: opts.organizer || '',
      n: opts.note || '',
      days: days,
      slots: slots
    };
  }

  function b64url(s) {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    var b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    var pad = b.length % 4;
    if (pad) b += '===='.slice(pad);
    return decodeURIComponent(escape(atob(b)));
  }

  function encodePoll(p) { return b64url(JSON.stringify(p)); }
  function decodePoll(t) {
    var p = JSON.parse(unb64url(t));
    if (!p || p.v !== 1) throw new Error('Unsupported poll');
    return p;
  }
  function encodeResponse(r) { return b64url(JSON.stringify(r)); }
  function decodeResponse(t) {
    var r = JSON.parse(unb64url(t));
    if (!r || r.v !== 1) throw new Error('Unsupported response');
    return r;
  }

  function slotIso(poll, dayIdx, slotIdx) {
    var date = poll.days[dayIdx];
    var time = poll.slots[slotIdx];
    if (!date || !time) return '';
    return date + 'T' + time + ':00';
  }

  // Fancy weekday/date label for column headers.
  function dayLabel(d) {
    var date = new Date(d + 'T00:00:00');
    var w = date.toLocaleDateString(undefined, { weekday: 'short' });
    var md = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { weekday: w, monthDay: md };
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.meet = {
    build: build,
    encodePoll: encodePoll,
    decodePoll: decodePoll,
    encodeResponse: encodeResponse,
    decodeResponse: decodeResponse,
    slotIso: slotIso,
    dayLabel: dayLabel
  };
})();
