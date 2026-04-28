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

  function loadingNote() {
    var s = document.createElement('span');
    s.className = 'muted small';
    s.textContent = 'loading…';
    return s;
  }

  function textFallback(value, onCommit) {
    var ti = document.createElement('input');
    ti.type = 'text';
    ti.className = 'editor editor-text';
    ti.value = value || '';
    bindCommit(ti, onCommit);
    return ti;
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

      case 'rating': {
        var rwrap = document.createElement('span');
        rwrap.className = 'editor editor-rating';
        rwrap.tabIndex = -1;
        var max = t.max || 5;
        var current = Math.max(t.min || 0, Math.min(max, Number(v) || 0));
        function paintStars(n) {
          rwrap.innerHTML = '';
          for (var i = 1; i <= max; i++) {
            (function (val) {
              var star = document.createElement('button');
              star.type = 'button';
              star.className = 'star-btn' + (val <= n ? ' on' : '');
              star.textContent = val <= n ? '★' : '☆';
              star.title = val + ' / ' + max;
              star.addEventListener('click', function (e) {
                e.preventDefault();
                onCommit(String(val));
              });
              rwrap.appendChild(star);
            })(i);
          }
        }
        paintStars(current);
        rwrap.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && onCancel) onCancel();
        });
        return rwrap;
      }

      case 'progress': {
        var pwrap = document.createElement('span');
        pwrap.className = 'editor editor-progress';
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = t.min == null ? 0 : t.min;
        slider.max = t.max == null ? 100 : t.max;
        slider.step = 1;
        slider.value = String(Number(v) || 0);
        var label = document.createElement('span');
        label.className = 'progress-label';
        label.textContent = slider.value;
        slider.addEventListener('input', function () { label.textContent = slider.value; });
        slider.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && onCancel) { onCancel(); return; }
          if (e.key === 'Enter') { e.preventDefault(); onCommit(slider.value); }
        });
        slider.addEventListener('change', function () { onCommit(slider.value); });
        slider.addEventListener('blur', function () {
          // ignore blurs that move focus inside the wrapper itself
          setTimeout(function () {
            if (!pwrap.contains(document.activeElement)) onCommit(slider.value);
          }, 0);
        });
        pwrap.appendChild(slider);
        pwrap.appendChild(label);
        return pwrap;
      }

      case 'multiselect': {
        var mw = document.createElement('span');
        mw.className = 'editor editor-multi';
        mw.tabIndex = -1;
        var picked = {};
        String(v || '').split(',').forEach(function (x) {
          var tx = x.trim(); if (tx) picked[tx] = true;
        });
        (t.options || []).forEach(function (opt) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'chip-btn' + (picked[opt] ? ' on' : '');
          btn.textContent = opt;
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (picked[opt]) { delete picked[opt]; btn.classList.remove('on'); }
            else { picked[opt] = true; btn.classList.add('on'); }
          });
          mw.appendChild(btn);
        });
        var done = document.createElement('button');
        done.type = 'button';
        done.className = 'btn done-btn';
        done.textContent = 'Done';
        done.addEventListener('click', function (e) {
          e.preventDefault();
          var keys = Object.keys(picked);
          onCommit(keys.join(', '));
        });
        mw.appendChild(done);
        mw.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && onCancel) onCancel();
          else if (e.key === 'Enter') {
            e.preventDefault();
            done.click();
          }
        });
        return mw;
      }

      case 'ref': {
        if (t.multi) {
          // Multi-ref: same chip-toggle UI as multiselect, options loaded from the ref tab.
          var rmw = document.createElement('span');
          rmw.className = 'editor editor-multi editor-ref-multi';
          rmw.tabIndex = -1;
          rmw.appendChild(loadingNote());
          var rmPicked = {};
          String(v || '').split(',').forEach(function (x) {
            var tx = x.trim(); if (tx) rmPicked[tx] = true;
          });
          var rmDone = document.createElement('button');
          rmDone.type = 'button';
          rmDone.className = 'btn done-btn';
          rmDone.textContent = 'Done';
          rmDone.addEventListener('click', function (e) {
            e.preventDefault();
            onCommit(Object.keys(rmPicked).join(', '));
          });
          Minerva.db.getAllRows(t.refTab).then(function (rows) {
            rmw.innerHTML = '';
            rows.forEach(function (r) {
              var label = r.title || r.name || r.id;
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'chip-btn' + (rmPicked[r.id] ? ' on' : '');
              btn.textContent = label;
              btn.title = r.id;
              btn.addEventListener('click', function (e) {
                e.preventDefault();
                if (rmPicked[r.id]) { delete rmPicked[r.id]; btn.classList.remove('on'); }
                else { rmPicked[r.id] = true; btn.classList.add('on'); }
              });
              rmw.appendChild(btn);
            });
            rmw.appendChild(rmDone);
          }).catch(function () {
            rmw.innerHTML = '';
            rmw.appendChild(textFallback(v, onCommit));
          });
          rmw.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && onCancel) onCancel();
            else if (e.key === 'Enter') { e.preventDefault(); rmDone.click(); }
          });
          return rmw;
        }
        // Single ref: dropdown of (id, label) pairs from the ref tab.
        var rsel = document.createElement('select');
        rsel.className = 'editor editor-ref';
        rsel.appendChild(makeOption('', '— loading…'));
        Minerva.db.getAllRows(t.refTab).then(function (rows) {
          rsel.innerHTML = '';
          rsel.appendChild(makeOption('', '—'));
          rows.forEach(function (r) {
            var label = r.title || r.name || r.id;
            rsel.appendChild(makeOption(r.id, label));
          });
          rsel.value = v;
        }).catch(function () {
          rsel.innerHTML = '';
          rsel.appendChild(makeOption(v, v));
          rsel.value = v;
        });
        rsel.addEventListener('change', function () { onCommit(rsel.value); });
        rsel.addEventListener('blur', function () { onCommit(rsel.value); });
        rsel.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && onCancel) onCancel();
        });
        return rsel;
      }

      // Fallback for anything else (text, drive, image, json, code, …).
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
