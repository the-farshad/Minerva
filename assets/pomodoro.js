/* Minerva — Pomodoro timer.
 *
 * A small floating widget bottom-left of the viewport that runs 25-minute
 * focus sessions followed by 5-minute breaks. State and unfinished session
 * survive reload via localStorage, so a brief navigation away or even
 * closing the tab doesn't lose the running session — the widget just
 * resumes from where the wall clock has carried it.
 *
 * On session-end (focus or break), the widget fires a desktop notification
 * (when permission is granted, sharing the same Minerva-wide setup as
 * task reminders) and, if the user's spreadsheet has a 'pomodoros' tab,
 * appends a row recording started/ended/duration/note.
 *
 * Public surface:
 *   Minerva.pomodoro.start({ note?, focusMin?, breakMin? })
 *   Minerva.pomodoro.stop()
 *   Minerva.pomodoro.toggle()  // start with defaults, or pause/resume
 *   Minerva.pomodoro.state()   // returns { phase, remainingMs, ... }
 *   Minerva.pomodoro.mount()   // ensures the floating widget exists
 */
(function () {
  'use strict';

  var KEY = 'minerva.pomo.v1';
  var DEFAULT_FOCUS = 25 * 60 * 1000;
  var DEFAULT_BREAK = 5 * 60 * 1000;

  var state = readState();
  var tickHandle = null;
  var widget = null;

  function readState() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && typeof raw === 'object') return raw;
    } catch (e) { /* ignore */ }
    return { phase: 'idle' }; // 'idle' | 'focus' | 'break' | 'paused'
  }
  function writeState(s) {
    state = s;
    try {
      if (s.phase === 'idle') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) { /* ignore */ }
    paint();
  }

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
  }

  function nowMs() { return Date.now(); }

  function remainingMs() {
    if (state.phase === 'focus' || state.phase === 'break') {
      return Math.max(0, state.endsAt - nowMs());
    }
    if (state.phase === 'paused') {
      return state.remainingAtPause || 0;
    }
    return 0;
  }

  // Compute next phase or finalize when the running phase elapses.
  function maybeAdvance() {
    if (state.phase === 'focus' && nowMs() >= state.endsAt) {
      finalizePhase('focus');
      writeState({
        phase: 'break',
        startedAt: nowMs(),
        endsAt: nowMs() + (state.breakMin || DEFAULT_BREAK / 60000) * 60000,
        focusMin: state.focusMin,
        breakMin: state.breakMin,
        note: state.note
      });
      desktopNotify('Break time', 'Step away for ' + (state.breakMin || 5) + ' minutes.');
    } else if (state.phase === 'break' && nowMs() >= state.endsAt) {
      desktopNotify('Break over', 'Ready for another focus session?');
      writeState({ phase: 'idle' });
    }
  }

  function finalizePhase(phase) {
    if (phase === 'focus') {
      // Browser notification for the immediate completion.
      desktopNotify('Focus complete', state.note ? 'Done: ' + state.note : 'Time for a break.');
      // Append a row to a 'pomodoros' tab if it exists in the local store.
      logSession({
        started: new Date(state.startedAt).toISOString(),
        ended: new Date(state.endsAt).toISOString(),
        duration: state.focusMin || (DEFAULT_FOCUS / 60000),
        note: state.note || ''
      });
    }
  }

  function desktopNotify(title, body) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      var n = new Notification(title, { body: body, tag: 'minerva-pomo', icon: 'docs/assets/minerva-logo.png' });
      n.onclick = function () { window.focus(); n.close(); };
    } catch (e) { /* ignore */ }
  }

  async function logSession(session) {
    try {
      if (!Minerva.db) return;
      var meta = await Minerva.db.getMeta('pomodoros');
      if (!meta || !meta.headers || !meta.headers.length) return; // tab doesn't exist
      var row = {
        id: Minerva.db.ulid(),
        _localOnly: 1, _dirty: 1, _deleted: 0, _rowIndex: null,
        _updated: new Date().toISOString()
      };
      meta.headers.forEach(function (h) {
        if (h === 'id' || h === '_updated' || h.charAt(0) === '_') return;
        if (h === 'started' && session.started) row[h] = session.started;
        else if (h === 'ended' && session.ended) row[h] = session.ended;
        else if (h === 'duration') row[h] = String(session.duration);
        else if (h === 'note' || h === 'task' || h === 'title') row[h] = session.note;
        else row[h] = '';
      });
      await Minerva.db.upsertRow('pomodoros', row);
      // Trigger a push if the app exposes the queue.
      if (window.MinervaSchedulePush) window.MinervaSchedulePush();
    } catch (e) { /* non-fatal */ }
  }

  // ---- UI -----------------------------------------------------

  function mount() {
    if (widget) return;
    widget = document.createElement('div');
    widget.className = 'pomo-widget';
    document.body.appendChild(widget);
    paint();
    if (!tickHandle) tickHandle = setInterval(function () {
      if (state.phase === 'focus' || state.phase === 'break') {
        maybeAdvance();
        paint();
      }
    }, 1000);
  }

  function lucide(name) {
    if (window.Minerva && Minerva.render && Minerva.render.icon) {
      return Minerva.render.icon(name);
    }
    var i = document.createElement('i');
    i.className = 'icon icon-lucide';
    i.setAttribute('data-lucide', name);
    return i;
  }

  function paint() {
    if (!widget) return;
    if (state.phase === 'idle') {
      widget.classList.remove('pomo-running', 'pomo-break', 'pomo-paused');
      widget.replaceChildren(
        startButton('Pomodoro', 'Start a 25-minute focus session', function () {
          start({ note: '' });
        })
      );
    } else if (state.phase === 'paused') {
      widget.classList.add('pomo-paused');
      widget.classList.remove('pomo-running', 'pomo-break');
      widget.replaceChildren(
        labelEl('timer', 'paused', fmt(state.remainingAtPause || 0)),
        iconButton('play', 'Resume', resume),
        iconButton('x', 'Stop', stop)
      );
    } else if (state.phase === 'focus' || state.phase === 'break') {
      widget.classList.toggle('pomo-running', state.phase === 'focus');
      widget.classList.toggle('pomo-break', state.phase === 'break');
      widget.classList.remove('pomo-paused');
      var iconName = state.phase === 'focus' ? 'timer' : 'coffee';
      var label = state.phase === 'focus' ? (state.note || 'focus') : 'break';
      widget.replaceChildren(
        labelEl(iconName, label, fmt(remainingMs())),
        iconButton('pause', 'Pause', pause),
        iconButton('x', 'Stop', stop)
      );
    }
    if (window.Minerva && Minerva.render && Minerva.render.refreshIcons) {
      Minerva.render.refreshIcons();
    }
  }

  function startButton(text, title, onclick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pomo-btn pomo-start';
    b.title = title;
    b.appendChild(lucide('timer'));
    b.appendChild(document.createTextNode(' ' + text));
    b.addEventListener('click', onclick);
    return b;
  }

  function iconButton(name, title, onclick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pomo-btn';
    b.title = title;
    b.appendChild(lucide(name));
    b.addEventListener('click', onclick);
    return b;
  }

  function labelEl(iconName, prefix, time) {
    var s = document.createElement('span');
    s.className = 'pomo-label';
    s.appendChild(lucide(iconName));
    s.appendChild(document.createTextNode(' ' + prefix + '  ' + time));
    return s;
  }


  // ---- actions -----------------------------------------------

  function start(opts) {
    opts = opts || {};
    var focusMin = opts.focusMin || 25;
    var breakMin = opts.breakMin || 5;
    var now = nowMs();
    writeState({
      phase: 'focus',
      startedAt: now,
      endsAt: now + focusMin * 60000,
      focusMin: focusMin,
      breakMin: breakMin,
      note: opts.note || ''
    });
  }

  function pause() {
    if (state.phase !== 'focus' && state.phase !== 'break') return;
    var rem = remainingMs();
    writeState({
      phase: 'paused',
      remainingAtPause: rem,
      pausedFromPhase: state.phase,
      focusMin: state.focusMin,
      breakMin: state.breakMin,
      note: state.note
    });
  }

  function resume() {
    if (state.phase !== 'paused') return;
    var phase = state.pausedFromPhase || 'focus';
    var now = nowMs();
    writeState({
      phase: phase,
      startedAt: now,
      endsAt: now + (state.remainingAtPause || 0),
      focusMin: state.focusMin,
      breakMin: state.breakMin,
      note: state.note
    });
  }

  function stop() {
    writeState({ phase: 'idle' });
  }

  function toggle() {
    if (state.phase === 'idle') start();
    else if (state.phase === 'paused') resume();
    else pause();
  }

  function getState() {
    return {
      phase: state.phase,
      remainingMs: remainingMs(),
      note: state.note || ''
    };
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.pomodoro = {
    mount: mount,
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    toggle: toggle,
    state: getState
  };
})();
