import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type Task = {
  id: string;
  text: string;
  done: boolean;
  parent: string | null;
};

type TaskNode = {
  id: string;
  text: string;
  done: boolean;
  children: TaskNode[];
};

type Config = {
  vault_folder: string;
  last_list: string | null;
  hotkey: string;
  sticky: boolean;
};

type View = "tasks" | "settings";

type DropZone = "before" | "after" | "inside";

type VaultInfo = { name: string; subpath: string };

type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; latest: string }
  | { kind: "available"; latest: string; url: string }
  | { kind: "error"; message: string };

const REPO_OWNER = "csteamengine";
const REPO_NAME = "tudu";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

const state = {
  lists: [] as string[],
  currentList: null as string | null,
  tree: [] as TaskNode[],
  config: null as Config | null,
  vaultInfo: null as VaultInfo | null,
  appVersion: null as string | null,
  updateStatus: { kind: "idle" } as UpdateStatus,
  view: "tasks" as View,
  addingSubFor: null as string | null,
  collapsed: new Set<string>(),
  creatingList: false,
  dragId: null as string | null,
  completedCollapsed: true,
};

const app = document.getElementById("content")!;

const MAX_UNDO = 50;
const undoStack: string[] = [];
const redoStack: string[] = [];

function pushUndo() {
  undoStack.push(JSON.stringify(state.tree));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

async function undo() {
  if (undoStack.length === 0 || !state.currentList) return;
  redoStack.push(JSON.stringify(state.tree));
  state.tree = JSON.parse(undoStack.pop()!);
  await saveTree();
  render();
}

async function redo() {
  if (redoStack.length === 0 || !state.currentList) return;
  undoStack.push(JSON.stringify(state.tree));
  state.tree = JSON.parse(redoStack.pop()!);
  await saveTree();
  render();
}

function buildTree(flat: Task[]): TaskNode[] {
  const byId = new Map<string, TaskNode>();
  for (const t of flat) byId.set(t.id, { id: t.id, text: t.text, done: t.done, children: [] });
  const roots: TaskNode[] = [];
  for (const t of flat) {
    const node = byId.get(t.id)!;
    if (t.parent && byId.has(t.parent)) byId.get(t.parent)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

async function loadConfig() {
  state.config = await invoke<Config>("get_config");
  try { state.vaultInfo = await invoke<VaultInfo | null>("get_vault_info"); }
  catch { state.vaultInfo = null; }
  if (state.appVersion === null) {
    try { state.appVersion = await invoke<string>("get_version"); }
    catch { state.appVersion = null; }
  }
}

function compareVersions(a: string, b: string): number {
  const parse = (s: string) => s.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdates() {
  if (state.updateStatus.kind === "checking") return;
  state.updateStatus = { kind: "checking" };
  if (state.view === "settings") render();
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tags?per_page=20`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const data = await r.json() as Array<{ name: string }>;
    const versionTags = data
      .map((t) => t.name)
      .filter((name) => /^v?\d+(\.\d+){0,2}$/.test(name))
      .sort((a, b) => compareVersions(b, a));
    const latest = versionTags[0];
    if (!latest) throw new Error("no version tags found");
    const current = state.appVersion ?? "0.0.0";
    const url = `${REPO_URL}/releases/tag/${latest}`;
    state.updateStatus = compareVersions(latest, current) > 0
      ? { kind: "available", latest, url }
      : { kind: "up-to-date", latest };
  } catch (err) {
    state.updateStatus = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (state.view === "settings") render();
}

async function loadLists() {
  state.lists = await invoke<string[]>("list_lists");
  if (state.currentList && !state.lists.includes(state.currentList)) state.currentList = null;
  if (!state.currentList) {
    const preferred = state.config?.last_list ?? null;
    state.currentList = preferred && state.lists.includes(preferred) ? preferred : (state.lists[0] ?? null);
  }
}

async function loadTasks() {
  if (!state.currentList) { state.tree = []; return; }
  try {
    const flat = await invoke<Task[]>("list_tasks", { list: state.currentList });
    state.tree = buildTree(flat);
  } catch { state.tree = []; }
}

async function refreshAll() { await loadLists(); await loadTasks(); render(); }

async function selectList(name: string) {
  state.currentList = name;
  state.addingSubFor = null;
  await invoke("set_last_list", { name });
  await loadTasks();
  render();
}

async function createList(name: string) {
  const created = await invoke<string>("create_list", { name });
  state.currentList = created;
  await invoke("set_last_list", { name: created });
  await loadLists();
  await loadTasks();
  render();
}

async function addTask(text: string, parent: string | null = null) {
  text = text.trim();
  if (!text || !state.currentList) return;
  pushUndo();
  await invoke("add_task", { list: state.currentList, text, parent });
  await loadTasks();
  render();
}

async function toggleTask(id: string, done: boolean) {
  if (!state.currentList) return;
  pushUndo();
  await invoke("toggle_task", { list: state.currentList, id, done });
  await loadTasks();
  if (!done) {
    const idx = state.tree.findIndex(n => n.id === id);
    if (idx > 0) {
      const [node] = state.tree.splice(idx, 1);
      state.tree.unshift(node);
      await saveTree();
    }
  }
  render();
}

async function editTask(id: string, text: string) {
  if (!state.currentList) return;
  await invoke("edit_task", { list: state.currentList, id, text });
}

async function deleteTask(id: string) {
  if (!state.currentList) return;
  pushUndo();
  await invoke("delete_task", { list: state.currentList, id });
  await loadTasks();
  render();
}

async function saveTree() {
  if (!state.currentList) return;
  await invoke("replace_tasks", { list: state.currentList, tree: state.tree });
}

async function saveConfig(partial: Partial<Config>) {
  const newConfig = { ...(state.config as Config), ...partial };
  await invoke("set_config", { newConfig });
  state.config = newConfig;
}

// Match either an Obsidian internal link (`[[Note]]` / `![[embed]]`) or a
// standard markdown link `[label](url)`. The Obsidian alternative is consumed
// first so its inner brackets can't be misread as a markdown link.
const LINK_RE = /(!?)\[\[([^\]\n]+)\]\]|\[([^\[\]\n]+)\]\(([^)\s]+)\)/g;

function obsidianUrl(target: string): string | null {
  const info = state.vaultInfo;
  if (!info) return null;
  const encoded = encodeURIComponent(target).replace(/%23/g, "#").replace(/%5E/gi, "^").replace(/%2F/gi, "/");
  return `obsidian://open?vault=${encodeURIComponent(info.name)}&file=${encoded}`;
}

function makeLinkAnchor(display: string, url: string, className: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = display;
  a.className = className;
  a.setAttribute("contenteditable", "false");
  a.href = url;
  a.title = "⌘+click to open";
  a.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      invoke("open_url", { url }).catch(() => {});
    }
  });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  return a;
}

function renderTaskText(span: HTMLElement, text: string) {
  span.textContent = "";
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const idx = m.index!;
    if (idx > last) span.append(document.createTextNode(text.slice(last, idx)));
    if (m[2] !== undefined) {
      const inner = m[2];
      const pipe = inner.indexOf("|");
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const display = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
      const url = obsidianUrl(target);
      if (url) {
        span.append(makeLinkAnchor(display, url, "md-link wiki-link"));
      } else {
        span.append(document.createTextNode(m[0]));
      }
    } else {
      span.append(makeLinkAnchor(m[3], m[4], "md-link"));
    }
    last = idx + m[0].length;
  }
  if (last < text.length) span.append(document.createTextNode(text.slice(last)));
}

function el(tag: string, props: Record<string, any> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "contentEditable") (node as any).contentEditable = v;
    else if (k in node) (node as any)[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

function render() {
  if (state.view === "settings") return renderSettings();
  renderTasks();
}

function isFullyDone(node: TaskNode): boolean {
  return node.done && node.children.every(isFullyDone);
}

function findAndRemove(tree: TaskNode[], id: string): TaskNode | null {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return tree.splice(i, 1)[0];
    const found = findAndRemove(tree[i].children, id);
    if (found) return found;
  }
  return null;
}

function isDescendant(node: TaskNode, id: string): boolean {
  if (node.id === id) return true;
  return node.children.some(c => isDescendant(c, id));
}

function findParentArray(tree: TaskNode[], id: string): { siblings: TaskNode[]; index: number } | null {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return { siblings: tree, index: i };
    const r = findParentArray(tree[i].children, id);
    if (r) return r;
  }
  return null;
}

function findNode(tree: TaskNode[], id: string): TaskNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}

async function performDrop(dragId: string, targetId: string, zone: DropZone) {
  if (dragId === targetId) return;
  const dragNode = findNode(state.tree, dragId);
  if (!dragNode) return;
  if (isDescendant(dragNode, targetId)) return;

  pushUndo();
  const removed = findAndRemove(state.tree, dragId);
  if (!removed) return;

  if (zone === "inside") {
    const target = findNode(state.tree, targetId);
    if (!target) { state.tree.push(removed); return; }
    target.children.push(removed);
    state.collapsed.delete(target.id);
  } else {
    const located = findParentArray(state.tree, targetId);
    if (!located) { state.tree.push(removed); return; }
    const idx = zone === "before" ? located.index : located.index + 1;
    located.siblings.splice(idx, 0, removed);
  }
  render();
  await saveTree();
}

function computeZone(e: DragEvent, row: HTMLElement): DropZone {
  const rect = row.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;
  if (y < h * 0.28) return "before";
  if (y > h * 0.72) return "after";
  return "inside";
}

let autoScrollRAF: number | null = null;
let lastDragClientY = 0;

function startAutoScroll() {
  if (autoScrollRAF !== null) return;
  const step = () => {
    autoScrollRAF = null;
    if (!state.dragId) return;
    const tasks = document.querySelector(".tasks") as HTMLElement | null;
    if (tasks) {
      const rect = tasks.getBoundingClientRect();
      const threshold = 48;
      const maxSpeed = 18;
      let dy = 0;
      if (lastDragClientY < rect.top + threshold) {
        const intensity = (rect.top + threshold - lastDragClientY) / threshold;
        dy = -Math.ceil(Math.min(1, intensity) * maxSpeed);
      } else if (lastDragClientY > rect.bottom - threshold) {
        const intensity = (lastDragClientY - (rect.bottom - threshold)) / threshold;
        dy = Math.ceil(Math.min(1, intensity) * maxSpeed);
      }
      if (dy !== 0) tasks.scrollTop += dy;
    }
    autoScrollRAF = requestAnimationFrame(step);
  };
  autoScrollRAF = requestAnimationFrame(step);
}

function stopAutoScroll() {
  if (autoScrollRAF !== null) {
    cancelAnimationFrame(autoScrollRAF);
    autoScrollRAF = null;
  }
}

function clearDropIndicators() {
  document.querySelectorAll(".task").forEach(n => {
    n.classList.remove("drop-before", "drop-after", "drop-inside");
  });
}

function renderTabs(): HTMLElement {
  const tabs = el("div", { class: "tabs", "data-tauri-drag-region": "" });
  for (const name of state.lists) {
    const active = name === state.currentList;
    tabs.append(el("button", {
      class: `tab ${active ? "active" : ""}`,
      "data-tauri-drag-region": "false",
      onclick: () => selectList(name),
    }, name));
  }
  if (state.creatingList) {
    const input = el("input", {
      class: "tab-input",
      placeholder: "List name",
      "data-tauri-drag-region": "false",
      onkeydown: async (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          const v = (e.target as HTMLInputElement).value.trim();
          if (!v) { state.creatingList = false; render(); return; }
          try { await createList(v); state.creatingList = false; }
          catch (err) { alert(String(err)); }
        } else if (e.key === "Escape") { state.creatingList = false; render(); }
      },
      onblur: () => { state.creatingList = false; render(); },
    });
    tabs.append(input);
    setTimeout(() => (input as HTMLInputElement).focus(), 0);
  } else {
    tabs.append(el("button", {
      class: "tab add",
      title: "New list",
      "data-tauri-drag-region": "false",
      onclick: () => { state.creatingList = true; render(); },
    }, "+"));
  }
  return tabs;
}

function renderTree(container: HTMLElement) {
  if (state.tree.length === 0) {
    container.append(el("div", { class: "empty" }, "No tasks. Start typing above."));
    return;
  }
  const walk = (nodes: TaskNode[], depth: number) => {
    for (const n of nodes) {
      container.append(renderTaskNode(n, depth));
      if (state.addingSubFor === n.id) container.append(renderInlineSubInput(n.id, depth + 1));
      if (n.children.length > 0 && !state.collapsed.has(n.id)) walk(n.children, depth + 1);
    }
  };

  const active = state.tree.filter(n => !isFullyDone(n));
  const completed = state.tree.filter(n => isFullyDone(n));

  walk(active, 0);

  if (completed.length > 0) {
    const count = completed.length;
    const arrow = state.completedCollapsed ? "▸" : "▾";
    const header = el("div", {
      class: "completed-header",
      onclick: () => { state.completedCollapsed = !state.completedCollapsed; render(); },
    },
      el("span", { class: "completed-arrow" }, arrow),
      el("span", {}, `Completed (${count})`),
    );
    container.append(header);
    if (!state.completedCollapsed) walk(completed, 0);
  }
}

function renderInlineSubInput(parentId: string, depth: number): HTMLElement {
  const pad = 14 + depth * 24;
  const input = el("input", {
    class: "compose-sub",
    placeholder: "Subtask…",
    style: `margin: 2px 12px 6px ${pad}px; width: calc(100% - ${pad + 24}px);`,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") { addTask((e.target as HTMLInputElement).value, parentId); state.addingSubFor = null; }
      else if (e.key === "Escape") { state.addingSubFor = null; render(); }
    },
    onblur: () => { state.addingSubFor = null; render(); },
  });
  setTimeout(() => (input as HTMLInputElement).focus(), 0);
  return input;
}

function renderTaskNode(t: TaskNode, depth: number): HTMLElement {
  const hasKids = t.children.length > 0;
  const collapsed = state.collapsed.has(t.id);
  const pad = 10 + depth * 24;

  const check = el("span", {
    class: "check",
    onclick: () => toggleTask(t.id, !t.done),
  }, t.done ? "✓" : "");

  const text = el("span", {
    class: "text",
    contentEditable: "true",
    onfocus: (e: Event) => {
      (e.target as HTMLElement).textContent = t.text;
    },
    onblur: (e: Event) => {
      const v = (e.target as HTMLElement).innerText.trim();
      if (v && v !== t.text) editTask(t.id, v);
      else if (!v) deleteTask(t.id);
      else renderTaskText(e.target as HTMLElement, t.text);
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); }
    },
  });
  renderTaskText(text, t.text);

  const actions = el("span", { class: "actions" },
    el("button", {
      title: "Add subtask",
      onclick: () => { state.addingSubFor = t.id; render(); },
    }, "+"),
    el("button", {
      title: "Delete",
      onclick: () => deleteTask(t.id),
    }, "✕"),
  );

  const caretRight = el("span", {
    class: `caret-right ${hasKids ? "" : "hidden"}`,
    onclick: () => {
      if (!hasKids) return;
      if (collapsed) state.collapsed.delete(t.id); else state.collapsed.add(t.id);
      render();
    },
  }, hasKids ? (collapsed ? "▸" : "▾") : "");

  const handle = el("span", { class: "grip", title: "Drag to reorder" }, "⋮⋮");

  const row = el("div", {
    class: `task ${t.done ? "done" : ""}`,
    style: `padding-left: ${pad}px;`,
    "data-id": t.id,
    ondragover: (e: DragEvent) => {
      if (!state.dragId || state.dragId === t.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const zone = computeZone(e, row);
      clearDropIndicators();
      row.classList.add(`drop-${zone}`);
    },
    ondragleave: () => row.classList.remove("drop-before", "drop-after", "drop-inside"),
    ondrop: async (e: DragEvent) => {
      e.preventDefault();
      if (!state.dragId) return;
      const zone = computeZone(e, row);
      clearDropIndicators();
      const dragId = state.dragId;
      state.dragId = null;
      row.removeAttribute("draggable");
      await performDrop(dragId, t.id, zone);
    },
    ondragstart: (e: DragEvent) => {
      state.dragId = t.id;
      if (e.dataTransfer) {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
      }
      row.classList.add("dragging");
      lastDragClientY = e.clientY;
      startAutoScroll();
    },
    ondragend: () => {
      state.dragId = null;
      row.classList.remove("dragging");
      row.removeAttribute("draggable");
      clearDropIndicators();
      stopAutoScroll();
    },
  }, check, text, actions, caretRight, handle);

  const TEXT_EDIT_BUFFER = 6;

  row.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, .check, .caret-right")) return;

    // Measure the actual rendered text glyphs (handles wrapped lines), not the
    // flex-expanded span — so the empty space to the right of short text is
    // drag territory, not edit territory.
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = Array.from(range.getClientRects());
    let minDist = Infinity;
    for (const r of rects) {
      const dx = Math.max(r.left - e.clientX, e.clientX - r.right, 0);
      const dy = Math.max(r.top - e.clientY, e.clientY - r.bottom, 0);
      minDist = Math.min(minDist, Math.hypot(dx, dy));
    }
    if (minDist < TEXT_EDIT_BUFFER) return;

    // Drag territory: disable contentEditable so the click can't focus the
    // text (which would swap rendered markdown back to plain text). We can't
    // use preventDefault here — webkit treats that as cancelling dragstart.
    text.contentEditable = "false";
    row.setAttribute("draggable", "true");
    const cleanup = () => {
      text.contentEditable = "true";
      if (state.dragId !== t.id) row.removeAttribute("draggable");
      document.removeEventListener("mouseup", cleanup);
    };
    document.addEventListener("mouseup", cleanup);
  });

  return row;
}

let composeInputRef: HTMLInputElement | null = null;

function renderTasks() {
  const prevScroll = document.querySelector(".tasks")?.scrollTop ?? 0;
  app.innerHTML = "";
  composeInputRef = null;

  const tabs = renderTabs();
  const topbar = el("div", { class: "topbar", "data-tauri-drag-region": "" },
    tabs,
    el("button", {
      class: "gear",
      title: "Settings",
      "data-tauri-drag-region": "false",
      onclick: () => { state.view = "settings"; render(); },
    }, "⚙"),
  );

  const input = el("input", {
    placeholder: state.currentList ? "Add a task…" : "Create a list first →",
    disabled: !state.currentList,
    autofocus: true,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const target = e.target as HTMLInputElement;
        addTask(target.value);
        target.value = "";
      } else if (e.key === "Escape") {
        invoke("hide_window");
      }
    },
  }) as HTMLInputElement;
  composeInputRef = input;
  const compose = el("div", { class: "compose" }, input);

  const list = el("div", { class: "tasks" });
  if (state.currentList) renderTree(list);
  else list.append(el("div", { class: "empty" }, "No lists yet. Click + above to create one."));

  app.append(topbar, list, compose);
  list.scrollTop = prevScroll;
  if (state.currentList && !state.addingSubFor && !state.creatingList) input.focus();
}

function eventToShortcut(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Cmd");
  const k = e.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(k)) return null;
  let token: string;
  if (k === " ") token = "Space";
  else if (k.length === 1) token = k.toUpperCase();
  else token = k;
  if (mods.length === 0) return null;
  return [...mods, token].join("+");
}

function renderSettings() {
  app.innerHTML = "";
  composeInputRef = null;
  const c = state.config!;

  const topbar = el("div", { class: "topbar", "data-tauri-drag-region": "" },
    el("button", {
      class: "gear",
      title: "Back",
      "data-tauri-drag-region": "false",
      onclick: () => { state.view = "tasks"; render(); },
    }, "‹"),
    el("span", { class: "settings-title", "data-tauri-drag-region": "" }, "Settings"),
    el("span", { class: "topbar-spacer" }),
  );

  const folder = el("input", {
    type: "text",
    value: c.vault_folder,
    onchange: async (e: Event) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (!v) return;
      await saveConfig({ vault_folder: v });
      await refreshAll();
    },
  }) as HTMLInputElement;

  const pickFolder = el("button", {
    type: "button",
    class: "inline-btn",
    title: "Choose folder…",
    onclick: async () => {
      await invoke("set_suppress_hide", { suppress: true });
      try {
        const picked = await open({ multiple: false, directory: true, defaultPath: folder.value });
        if (typeof picked === "string") {
          folder.value = picked;
          await saveConfig({ vault_folder: picked });
          await refreshAll();
        }
      } finally {
        await invoke("set_suppress_hide", { suppress: false });
      }
    },
  }, "📁");

  const folderRow = el("div", { class: "input-group" }, folder, pickFolder);

  const hotkeyDisplay = el("input", {
    type: "text",
    value: c.hotkey,
    readOnly: true,
    class: "hotkey-display",
  }) as HTMLInputElement;

  let recording = false;
  const recordBtn = el("button", {
    type: "button",
    class: "inline-btn",
    onclick: () => {
      if (recording) return;
      recording = true;
      hotkeyDisplay.value = "Press key combo…";
      hotkeyDisplay.classList.add("recording");
      recordBtn.textContent = "Cancel";

      const onKey = async (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") { stop(c.hotkey); return; }
        const combo = eventToShortcut(e);
        if (!combo) return;
        stop(combo);
        try {
          await saveConfig({ hotkey: combo });
        } catch (err) {
          alert(String(err));
          hotkeyDisplay.value = state.config!.hotkey;
        }
      };
      const stop = (val: string) => {
        recording = false;
        hotkeyDisplay.value = val;
        hotkeyDisplay.classList.remove("recording");
        recordBtn.textContent = "Record";
        window.removeEventListener("keydown", onKey, true);
      };
      window.addEventListener("keydown", onKey, true);
    },
  }, "Record");

  const hotkeyRow = el("div", { class: "input-group" }, hotkeyDisplay, recordBtn);

  const sticky = el("input", {
    type: "checkbox",
    id: "sticky-check",
    onchange: async (e: Event) => {
      await saveConfig({ sticky: (e.target as HTMLInputElement).checked });
    },
  }) as HTMLInputElement;
  sticky.checked = c.sticky;
  const stickyRow = el("label", { class: "inline-row checkbox-row", htmlFor: "sticky-check" },
    sticky,
    el("span", {}, "Sticky (stay visible when unfocused)"),
  );

  const status = state.updateStatus;
  const statusEl = el("span", { class: `update-status ${status.kind}` });
  if (status.kind === "checking") statusEl.textContent = "Checking…";
  else if (status.kind === "up-to-date") statusEl.textContent = `Up to date (${status.latest})`;
  else if (status.kind === "available") {
    statusEl.append(
      document.createTextNode(`New version available: `),
      el("a", {
        class: "release-link",
        onclick: (e: Event) => {
          e.preventDefault();
          if (status.kind === "available") invoke("open_url", { url: status.url }).catch(() => {});
        },
      }, status.latest),
    );
  } else if (status.kind === "error") statusEl.textContent = `Check failed: ${status.message}`;

  const checkBtn = el("button", {
    type: "button",
    class: "inline-btn",
    onclick: () => checkForUpdates(),
  }, status.kind === "checking" ? "Checking…" : "Check for updates");

  const versionLine = el("div", { class: "settings-version" },
    el("span", { class: "version-label" }, `Tudu v${state.appVersion ?? "?"}`),
    el("a", {
      class: "github-link",
      title: "Open repository on GitHub",
      onclick: (e: Event) => {
        e.preventDefault();
        invoke("open_url", { url: REPO_URL }).catch(() => {});
      },
    }, githubIcon()),
  );

  const updatesRow = el("div", { class: "input-group updates-row" }, checkBtn, statusEl);

  const body = el("div", { class: "settings" },
    el("label", {}, "Vault folder", folderRow),
    el("label", {}, "Global hotkey", hotkeyRow),
    stickyRow,
    el("label", {}, "Updates", updatesRow),
    versionLine,
  );

  app.append(topbar, body);
}

function githubIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8.2 8 8 0 0 0 8 .2Z");
  svg.append(path);
  return svg;
}

async function init() {
  await loadConfig();
  await loadLists();
  await loadTasks();
  render();

  let refreshTimer: number | null = null;
  let lastSnapshot = "";
  await listen("tasks-changed", () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(async () => {
      refreshTimer = null;
      const prevLists = state.lists.join("|");
      await loadLists();
      await loadTasks();
      const snap = state.lists.join("|") + "\0" + JSON.stringify(state.tree);
      if (snap === lastSnapshot && prevLists === state.lists.join("|")) return;
      lastSnapshot = snap;
      render();
    }, 250);
  });

  await listen("window-shown", () => {
    if (state.view === "tasks" && composeInputRef) {
      composeInputRef.focus();
      composeInputRef.select();
    }
  });

  await listen("open-settings", () => {
    state.view = "settings";
    render();
  });

  await listen("check-updates", () => {
    state.view = "settings";
    render();
    checkForUpdates();
  });

  document.addEventListener("dragover", (e) => {
    if (!state.dragId) return;
    lastDragClientY = e.clientY;
  });

  document.addEventListener("dragend", () => {
    state.dragId = null;
    stopAutoScroll();
    clearDropIndicators();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.key !== "Escape") return;
    if (state.view === "settings") {
      e.preventDefault();
      state.view = "tasks";
      render();
      return;
    }
    if (state.addingSubFor || state.creatingList) return;
    e.preventDefault();
    invoke("hide_window");
  });
}

init();
