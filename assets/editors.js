/* Minerva — type-aware inline editors.
 *
 * Minerva.editors.make(value, type, onCommit, onCancel)
 *   returns an HTML element bound to the given value and type. When the user
 *   commits (Enter / blur / change for non-text), onCommit(newValue) fires
 *   with the string the cell should be saved as. Escape cancels (no commit).
 *
 * Phase 3a covers: text, longtext/markdown, number, date, datetime, check,
 * select(...), link. Other types fall back to a text input — proper editors
 * for ref(), multiselect, rating, progress, drive, etc. arrive in Phase 3b.
 */
(function () {
  'use strict';

  function makeOption(value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  function bindCommit(input, onCommit, onCancel) {
    var cancelled = false;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && input.tagName !== 'TEXTAREA') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelled = true;
        if (onCancel) onCancel();
        input.blur();
      }
    });
    input.addEventListener('blur', function () {
      if (cancelled) return;
      onCommit(input.value);
    });
  }

  function make(value, type, onCommit, onCancel) {
    var t = (type && typeof type === 'object') ? type : Minerva.render.parseType(type);
    var v = value == null ? '' : String(value);

    switch (t.kind) {
      case 'check': {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'editor editor-check';
        var on = v === 'TRUE' || v === 'true' || v === '1' || value === true;
        cb.checked = on;
        cb.addEventListener('change', function () { onCommit(cb.checked ? 'TRUE' : 'FALSE'); });
        cb.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && onCancel) onCancel();
        });
        return cb;
      }

      case 'select': {
        var sel = document.createElement('select');
        sel.className = 'editor editor-select';
        sel.appendChild(makeOption('', '—'));
        (t.options || []).forEach(function (o) { sel.appendChild(makeOption(o, o)); });
        sel.value = v;
        sel.addEventListener('change', function () { onCommit(sel.value); });
        sel.addEventListener('blur', function () { onCommit(sel.value); });
        sel.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && onCancel) onCancel();
        });
        return sel;
      }

      case 'longtext':
      case 'markdown':
      case 'json':
      case 'code': {
        var ta = document.createElement('textarea');
        ta.className = 'editor editor-text';
        ta.rows = 3;
        ta.value = v;
        bindCommit(ta, onCommit, onCancel);
        return ta;
      }

      case 'number': {
        var ni = document.createElement('input');
        ni.type = 'number';
        ni.className = 'editor editor-number';
        ni.value = v;
        bindCommit(ni, onCommit, onCancel);
        return ni;
      }

      case 'date': {
        var di = document.createElement('input');
        di.type = 'date';
        di.className = 'editor editor-date';
        di.value = /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '';
        bindCommit(di, onCommit, onCancel);
        return di;
      }

      case 'datetime': {
        var dti = document.createElement('input');
        dti.type = 'datetime-local';
        dti.className = 'editor editor-datetime';
        dti.value = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : '';
        bindCommit(dti, function (raw) {
          // Re-emit as full ISO so the spreadsheet stores a sortable timestamp.
          if (!raw) return onCommit('');
          onCommit(new Date(raw).toISOString());
        }, onCancel);
        return dti;
      }

      case 'link': {
        var li = document.createElement('input');
        li.type = 'url';
        li.className = 'editor editor-link';
        li.value = v;
        li.placeholder = 'https://…';
        bindCommit(li, onCommit, onCancel);
        return li;
      }

      case 'color': {
        var ci = document.createElement('input');
        ci.type = 'color';
        ci.className = 'editor editor-color';
        ci.value = /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#888888';
        ci.addEventListener('change', function () { onCommit(ci.value); });
        ci.addEventListener('blur', function () { onCommit(ci.value); });
        return ci;
      }

      // Fallback for anything not yet implemented (text, ref, multiselect,
      // rating, progress, drive, image, …) — plain text input.
      default: {
        var ti = document.createElement('input');
        ti.type = 'text';
        ti.className = 'editor editor-text';
        ti.value = v;
        bindCommit(ti, onCommit, onCancel);
        return ti;
      }
    }
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.editors = { make: make };
})();
