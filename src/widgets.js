'use strict';

/* ===========================================================================
   WorkHub — Sticky notes & To-do lists
   A self-contained module (kept out of renderer.js to keep that file lean).
   - Sticky notes: draggable around the window, pinned with a coloured pin,
     yellow paper + handwriting font by default; note colour, pin colour and
     font are all changeable. Drag a note onto the sidebar (or hit the store
     button) to tuck it away in the sidebar; click it there to bring it back.
   - To-do lists: notebook-style dialogs, draggable, collapsible, storeable in
     the sidebar; each has a title and check-off items. Add as many as you like.
   Everything persists via window.workhub.setNotes / setTodos.
   =========================================================================== */

(function () {
  const api = window.workhub;
  if (!api) return;

  let notes = [];
  let todos = [];
  let layer = null;
  let saveNotesTimer = null;
  let saveTodosTimer = null;

  const NOTE_COLORS = ['#fde68a', '#fca5a5', '#a7f3d0', '#bfdbfe', '#fdba74', '#f5d0fe', '#ffffff'];
  const PIN_COLORS  = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#0f172a'];

  const $ = (id) => document.getElementById(id);
  const uid = () => 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cycle = (arr, cur) => arr[(arr.indexOf(cur) + 1) % arr.length];

  function saveNotes() { clearTimeout(saveNotesTimer); saveNotesTimer = setTimeout(() => { try { api.setNotes(notes); } catch (e) {} }, 400); }
  function saveTodos() { clearTimeout(saveTodosTimer); saveTodosTimer = setTimeout(() => { try { api.setTodos(todos); } catch (e) {} }, 400); }

  function ensureLayer() {
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'widget-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function pinSvg(color) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
      + '<circle cx="12" cy="8" r="5.5" fill="' + color + '"/>'
      + '<circle cx="10" cy="6" r="1.6" fill="rgba(255,255,255,.55)"/>'
      + '<rect x="11.2" y="12" width="1.6" height="9" rx=".8" fill="' + color + '" opacity=".75"/>'
      + '</svg>';
  }

  function iconBtn(title, svg, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wtool';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  const SVG = {
    palette: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/><circle cx="15" cy="9" r="1.4" fill="currentColor"/><circle cx="9" cy="15" r="1.4" fill="currentColor"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 3h6l-1 6 3 3H7l3-3-1-6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 12v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    store: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 4v10m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
  };

  // ---- generic drag (by a handle); stores to sidebar if dropped over it -----
  function makeDraggable(el, handle, obj, persist) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, textarea, a, .wtool')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = obj.x || 0, oy = obj.y || 0;
      el.classList.add('dragging');
      const move = (ev) => {
        obj.x = Math.max(0, Math.min(window.innerWidth - 48, ox + (ev.clientX - sx)));
        obj.y = Math.max(0, Math.min(window.innerHeight - 28, oy + (ev.clientY - sy)));
        el.style.left = obj.x + 'px';
        el.style.top = obj.y + 'px';
      };
      const up = (ev) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        el.classList.remove('dragging');
        const sb = $('sidebar');
        if (sb) {
          const r = sb.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
            obj.stored = true;
            persist();
            renderAll();
            return;
          }
        }
        persist();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  // ------------------------------- NOTES -------------------------------------
  function renderNote(n) {
    const el = document.createElement('div');
    el.className = 'sticky' + (n.font === 'plain' ? ' plain' : '');
    el.style.left = (n.x || 60) + 'px';
    el.style.top = (n.y || 90) + 'px';
    el.style.background = n.color || NOTE_COLORS[0];

    const pin = document.createElement('div');
    pin.className = 'sticky-pin';
    pin.innerHTML = pinSvg(n.pinColor || PIN_COLORS[0]);

    const tools = document.createElement('div');
    tools.className = 'sticky-tools';
    tools.appendChild(iconBtn('Note colour', SVG.palette, () => { n.color = cycle(NOTE_COLORS, n.color || NOTE_COLORS[0]); el.style.background = n.color; saveNotes(); }));
    tools.appendChild(iconBtn('Pin colour', SVG.pin, () => { n.pinColor = cycle(PIN_COLORS, n.pinColor || PIN_COLORS[0]); pin.innerHTML = pinSvg(n.pinColor); saveNotes(); }));
    const fontBtn = iconBtn('Toggle handwriting font', '', () => {
      n.font = n.font === 'plain' ? 'hand' : 'plain';
      el.classList.toggle('plain', n.font === 'plain');
      fontBtn.textContent = n.font === 'plain' ? 'Aa' : '𝒜';
      saveNotes();
    });
    fontBtn.textContent = n.font === 'plain' ? 'Aa' : '𝒜';
    fontBtn.classList.add('wtool-text');
    tools.appendChild(fontBtn);
    tools.appendChild(iconBtn('Store in sidebar', SVG.store, () => { n.stored = true; saveNotes(); renderAll(); }));
    tools.appendChild(iconBtn('Delete note', SVG.close, () => { notes = notes.filter((x) => x.id !== n.id); saveNotes(); renderAll(); }));

    const ta = document.createElement('textarea');
    ta.className = 'sticky-text';
    ta.value = n.text || '';
    ta.placeholder = 'Write a note…';
    ta.addEventListener('input', () => { n.text = ta.value; saveNotes(); });

    el.appendChild(pin);
    el.appendChild(tools);
    el.appendChild(ta);
    makeDraggable(el, pin, n, saveNotes);
    ensureLayer().appendChild(el);
  }

  function renderSidebarNotes() {
    const wrap = $('notesList');
    if (!wrap) return;
    wrap.innerHTML = '';
    const stored = notes.filter((n) => n.stored);
    if (!stored.length) return;   // empty: just the header + button, nothing else
    for (const n of stored) {
      const item = document.createElement('div');
      item.className = 'wid-item';
      item.title = (n.text || 'Empty note');
      const dot = document.createElement('span');
      dot.className = 'wid-dot';
      dot.style.background = n.color || NOTE_COLORS[0];
      const label = document.createElement('span');
      label.className = 'wid-label';
      label.textContent = (n.text || 'Empty note').split('\n')[0].slice(0, 40) || 'Empty note';
      const del = iconBtn('Delete', SVG.close, () => { notes = notes.filter((x) => x.id !== n.id); saveNotes(); renderAll(); });
      del.classList.add('wid-del');
      item.appendChild(dot);
      item.appendChild(label);
      item.appendChild(del);
      item.addEventListener('click', (e) => { if (e.target.closest('.wid-del')) return; n.stored = false; saveNotes(); renderAll(); });
      wrap.appendChild(item);
    }
  }

  function newNote() {
    const n = {
      id: uid(), text: '',
      x: 80 + (notes.length % 5) * 26, y: 100 + (notes.length % 5) * 26,
      color: NOTE_COLORS[0], pinColor: PIN_COLORS[0], font: 'hand', stored: false
    };
    notes.push(n);
    saveNotes();
    renderAll();
  }

  // ------------------------------- TO-DOS ------------------------------------
  function renderTodo(t) {
    const el = document.createElement('div');
    el.className = 'todo-win' + (t.collapsed ? ' collapsed' : '');
    el.style.left = (t.x || 120) + 'px';
    el.style.top = (t.y || 120) + 'px';

    const head = document.createElement('div');
    head.className = 'todo-head';
    const collapseBtn = iconBtn('Collapse', SVG.chevron, () => { t.collapsed = !t.collapsed; el.classList.toggle('collapsed', t.collapsed); saveTodos(); });
    collapseBtn.classList.add('todo-collapse');
    const title = document.createElement('input');
    title.className = 'todo-title';
    title.value = t.title || 'To-do';
    title.placeholder = 'List name';
    title.addEventListener('input', () => { t.title = title.value; saveTodos(); renderSidebarTodos(); });
    const headTools = document.createElement('div');
    headTools.className = 'todo-head-tools';
    headTools.appendChild(iconBtn('Store in sidebar', SVG.store, () => { t.stored = true; saveTodos(); renderAll(); }));
    headTools.appendChild(iconBtn('Delete list', SVG.close, () => { todos = todos.filter((x) => x.id !== t.id); saveTodos(); renderAll(); }));
    head.appendChild(collapseBtn);
    head.appendChild(title);
    head.appendChild(headTools);

    const body = document.createElement('div');
    body.className = 'todo-body';
    const list = document.createElement('div');
    list.className = 'todo-items';
    (t.items || []).forEach((it) => list.appendChild(renderTodoItem(t, it)));
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'todo-add';
    addBtn.innerHTML = SVG.plus + '<span>Add item</span>';
    addBtn.addEventListener('click', () => {
      const it = { id: uid(), text: '', done: false };
      t.items = t.items || [];
      t.items.push(it);
      const row = renderTodoItem(t, it);
      list.appendChild(row);
      const inp = row.querySelector('input.todo-text');
      if (inp) inp.focus();
      saveTodos();
    });
    body.appendChild(list);
    body.appendChild(addBtn);

    el.appendChild(head);
    el.appendChild(body);
    makeDraggable(el, head, t, saveTodos);
    ensureLayer().appendChild(el);
  }

  function renderTodoItem(t, it) {
    const row = document.createElement('div');
    row.className = 'todo-item' + (it.done ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!it.done;
    cb.addEventListener('change', () => { it.done = cb.checked; row.classList.toggle('done', it.done); saveTodos(); });
    const txt = document.createElement('input');
    txt.type = 'text';
    txt.className = 'todo-text';
    txt.value = it.text || '';
    txt.placeholder = 'Task…';
    txt.addEventListener('input', () => { it.text = txt.value; saveTodos(); });
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const next = row.nextSibling; const addB = row.parentElement.parentElement.querySelector('.todo-add'); if (addB) addB.click(); }
    });
    const del = iconBtn('Remove', SVG.close, () => { t.items = t.items.filter((x) => x.id !== it.id); row.remove(); saveTodos(); });
    del.classList.add('todo-item-del');
    row.appendChild(cb);
    row.appendChild(txt);
    row.appendChild(del);
    return row;
  }

  function renderSidebarTodos() {
    const wrap = $('todosList');
    if (!wrap) return;
    wrap.innerHTML = '';
    const stored = todos.filter((t) => t.stored);
    if (!stored.length) return;   // empty: just the header + button, nothing else
    for (const t of stored) {
      const item = document.createElement('div');
      item.className = 'wid-item';
      const done = (t.items || []).filter((i) => i.done).length;
      const total = (t.items || []).length;
      item.title = (t.title || 'To-do') + ' — ' + done + '/' + total + ' done';
      const dot = document.createElement('span');
      dot.className = 'wid-dot todo';
      const label = document.createElement('span');
      label.className = 'wid-label';
      label.textContent = (t.title || 'To-do') + (total ? ' (' + done + '/' + total + ')' : '');
      const del = iconBtn('Delete', SVG.close, () => { todos = todos.filter((x) => x.id !== t.id); saveTodos(); renderAll(); });
      del.classList.add('wid-del');
      item.appendChild(dot);
      item.appendChild(label);
      item.appendChild(del);
      item.addEventListener('click', (e) => { if (e.target.closest('.wid-del')) return; t.stored = false; saveTodos(); renderAll(); });
      wrap.appendChild(item);
    }
  }

  function newTodo() {
    const t = {
      id: uid(), title: 'To-do', items: [{ id: uid(), text: '', done: false }],
      x: 160 + (todos.length % 5) * 26, y: 140 + (todos.length % 5) * 26,
      collapsed: false, stored: false
    };
    todos.push(t);
    saveTodos();
    renderAll();
  }

  // ------------------------------- RENDER ------------------------------------
  function renderAll() {
    if (layer) layer.innerHTML = '';
    notes.filter((n) => !n.stored).forEach(renderNote);
    todos.filter((t) => !t.stored).forEach(renderTodo);
    renderSidebarNotes();
    renderSidebarTodos();
  }

  // ------------------------------- INIT --------------------------------------
  async function init() {
    try {
      const cfg = await api.getConfig();
      notes = Array.isArray(cfg && cfg.notes) ? cfg.notes : [];
      todos = Array.isArray(cfg && cfg.todos) ? cfg.todos : [];
    } catch (e) { notes = []; todos = []; }

    const nb = $('newNoteBtn');
    const tb = $('newTodoBtn');
    if (nb) nb.addEventListener('click', newNote);
    if (tb) tb.addEventListener('click', newTodo);

    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
