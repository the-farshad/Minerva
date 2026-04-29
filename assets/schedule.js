/* Minerva — schedule + availability helpers.
 *
 * Pulls busy blocks out of the user's local store and computes free slots
 * inside their working-hours window. "Busy" = any row in any tab whose
 * type-hint schema declares both a start (datetime) and end (datetime)
 * column with non-empty values, plus tasks with a `due` (date or
 * datetime) and optional `duration`. Working hours default to 9:00–18:00,
 * configurable later from _prefs.
 *
 * Surfaces:
 *   collectBusy(opts)  → [{ start: Date, end: Date, label, tab, rowId }]
 *   freeSlots(busy, opts) → [{ start: Date, end: Date }]
 *   encodeAvailability(slots, meta) → token (base64url-utf8)
 *   decodeAvailability(token) → { slots, meta }
 */
(function () {
  'use strict';

  function dayKey(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function parseDateLike(v) {
    if (!v) return null;
    var s = String(v).trim();
    if (!s) return null;
    // ISO datetime: YYYY-MM-DDTHH:MM[:SS[.fff]][Z|+HH:MM]
    if (/T\d{2}:\d{2}/.test(s)) {
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    // ISO date only
    var dm = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dm) return new Date(+dm[1], +dm[2] - 1, +dm[3], 0, 0, 0);
    var d2 = new Date(s);
    return isNaN(d2.getTime()) ? null : d2;
  }

  // Look at every cached tab's headers/types for any pair of (start, end)
  // datetime columns. Returns blocks across all matching tabs.
  async function collectBusyFromEvents(rangeStart, rangeEnd) {
    if (!Minerva.db) return [];
    var allMeta = await Minerva.db.getAllMeta();
    var blocks = [];
    for (var m of allMeta) {
      if (!m || !m.headers || !m.types) continue;
      // find first datetime "start"-ish + "end"-ish column
      var startCol = null, endCol = null;
      for (var i = 0; i < m.headers.length; i++) {
        var h = m.headers[i];
        var t = (m.types[i] || '').toLowerCase();
        if (!startCol && (h === 'start' || h === 'starts' || h === 'start_at') && /date/.test(t)) startCol = h;
        if (!endCol && (h === 'end' || h === 'ends' || h === 'end_at') && /date/.test(t)) endCol = h;
      }
      if (!startCol || !endCol) continue;
      var rows = await Minerva.db.getAllRows(m.tab);
      rows.forEach(function (r) {
        if (r._deleted) return;
        var s = parseDateLike(r[startCol]);
        var e = parseDateLike(r[endCol]);
        if (!s || !e) return;
        if (e <= s) return;
        if (e < rangeStart || s > rangeEnd) return;
        blocks.push({
          start: s,
          end: e,
          label: r.title || r.name || r.id,
          tab: m.tab,
          rowId: r.id
        });
      });
    }
    return blocks;
  }

  // Tasks with a due date count as busy blocks: a `duration:duration` column
  // (when present) gives the length, otherwise default 30 minutes anchored
  // at the workday start of the due date.
  async function collectBusyFromTasks(rangeStart, rangeEnd, opts) {
    if (!Minerva.db) return [];
    var blocks = [];
    var meta = await Minerva.db.getMeta('tasks');
    if (!meta || !meta.headers) return blocks;
    var rows = await Minerva.db.getAllRows('tasks');
    var workStart = opts && opts.workStart != null ? opts.workStart : 9;
    rows.forEach(function (r) {
      if (r._deleted) return;
      if (String(r.status || '').toLowerCase() === 'done') return;
      if (!r.due) return;
      var due = parseDateLike(r.due);
      if (!due) return;
      // If due is date-only (midnight), schedule a 30-min slot at workStart.
      if (due.getHours() === 0 && due.getMinutes() === 0 && !/T/.test(String(r.due))) {
        due.setHours(workStart, 0, 0, 0);
      }
      if (due < rangeStart || due > rangeEnd) return;
      var durationMin = parseDuration(r.duration) || 30;
      var end = new Date(due.getTime() + durationMin * 60000);
      blocks.push({
        start: due,
        end: end,
        label: r.title || r.id,
        tab: 'tasks',
        rowId: r.id
      });
    });
    return blocks;
  }

  // Parses "1h 30m" / "90m" / "1.5h" / "0:90" / "90" → minutes.
  function parseDuration(v) {
    if (!v) return 0;
    var s = String(v).trim().toLowerCase();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var hMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
    var mMatch = s.match(/(\d+(?:\.\d+)?)\s*m/);
    var total = 0;
    if (hMatch) total += parseFloat(hMatch[1]) * 60;
    if (mMatch) total += parseFloat(mMatch[1]);
    if (total) return Math.round(total);
    var c = s.match(/^(\d+):(\d+)$/);
    if (c) return parseInt(c[1], 10) * 60 + parseInt(c[2], 10);
    return 0;
  }

  async function collectBusy(opts) {
    opts = opts || {};
    var rangeStart = opts.start || new Date();
    var rangeEnd = opts.end || new Date(rangeStart.getTime() + 7 * 86400000);
    var fromEvents = await collectBusyFromEvents(rangeStart, rangeEnd);
    var fromTasks = await collectBusyFromTasks(rangeStart, rangeEnd, opts);
    var all = fromEvents.concat(fromTasks);
    all.sort(function (a, b) { return a.start - b.start; });
    return all;
  }

  // Compute free slots within work hours, day-by-day, subtracting busy blocks.
  // opts: { start, end, workStart=9, workEnd=18, slotMin=30 }
  function freeSlots(busy, opts) {
    opts = opts || {};
    var workStart = opts.workStart != null ? opts.workStart : 9;
    var workEnd = opts.workEnd != null ? opts.workEnd : 18;
    var slotMin = opts.slotMin || 30;
    var rangeStart = opts.start || new Date();
    var rangeEnd = opts.end || new Date(rangeStart.getTime() + 7 * 86400000);

    var slots = [];
    var d = new Date(rangeStart);
    d.setHours(0, 0, 0, 0);
    while (d < rangeEnd) {
      var dayStart = new Date(d); dayStart.setHours(workStart, 0, 0, 0);
      var dayEnd = new Date(d); dayEnd.setHours(workEnd, 0, 0, 0);
      // Optional: skip weekends.
      if (opts.skipWeekends && (d.getDay() === 0 || d.getDay() === 6)) {
        d.setDate(d.getDate() + 1);
        continue;
      }
      var dayBusy = busy.filter(function (b) {
        return b.end > dayStart && b.start < dayEnd;
      }).sort(function (a, b) { return a.start - b.start; });

      var cursor = new Date(Math.max(dayStart, rangeStart));
      dayBusy.forEach(function (b) {
        if (b.start > cursor) {
          var gap = b.start - cursor;
          if (gap >= slotMin * 60000) {
            slots.push({ start: new Date(cursor), end: new Date(b.start) });
          }
        }
        if (b.end > cursor) cursor = new Date(b.end);
      });
      if (cursor < dayEnd) {
        var tail = dayEnd - cursor;
        if (tail >= slotMin * 60000) {
          slots.push({ start: new Date(cursor), end: new Date(dayEnd) });
        }
      }
      d.setDate(d.getDate() + 1);
    }
    return slots;
  }

  // Compact encoding for sharing — slots are stored as start ISO + duration
  // minutes to keep the URL hash short.
  function encodeAvailability(slots, meta) {
    var payload = {
      v: 1,
      meta: meta || {},
      slots: slots.map(function (s) {
        return [s.start.toISOString(), Math.round((s.end - s.start) / 60000)];
      })
    };
    var json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeAvailability(token) {
    var b64 = String(token || '').replace(/-/g, '+').replace(/_/g, '/');
    var pad = b64.length % 4;
    if (pad) b64 += '===='.slice(pad);
    var payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (!payload || payload.v !== 1) throw new Error('Unsupported availability token');
    return {
      meta: payload.meta || {},
      slots: (payload.slots || []).map(function (p) {
        var s = new Date(p[0]);
        var e = new Date(s.getTime() + (p[1] || 30) * 60000);
        return { start: s, end: e };
      })
    };
  }

  function fmtRange(slot) {
    var s = slot.start, e = slot.end;
    var dateStr = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var t = function (d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    return dateStr + '  ' + t(s) + '–' + t(e);
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.schedule = {
    collectBusy: collectBusy,
    freeSlots: freeSlots,
    encodeAvailability: encodeAvailability,
    decodeAvailability: decodeAvailability,
    parseDateLike: parseDateLike,
    fmtRange: fmtRange,
    dayKey: dayKey
  };
})();
