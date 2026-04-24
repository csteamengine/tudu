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

const state = {
  lists: [] as string[],
  currentList: null as string | null,
  tree: [] as TaskNode[],
  config: null as Config | null,
  view: "tasks" as View,
  addingSubFor: null as string | null,
  collapsed: new Set<string>(),
  creatingList: false,
  dragId: null as string | null,
};

const app = document.getElementById("content")!;

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

async function loadConfig() { state.config = await invoke<Config>("get_config"); }

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
  await invoke("add_task", { list: state.currentList, text, parent });
  await loadTasks();
  render();
}

async function toggleTask(id: string, done: boolean) {
  if (!state.currentList) return;
  await invoke("toggle_task", { list: state.currentList, id, done });
  await loadTasks();
  render();
}

async function editTask(id: string, text: string) {
  if (!state.currentList) return;
  await invoke("edit_task", { list: state.currentList, id, text });
}

async function deleteTask(id: string) {
  if (!state.currentList) return;
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
  walk(state.tree, 0);
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
    onblur: (e: Event) => {
      const v = (e.target as HTMLElement).innerText.trim();
      if (v && v !== t.text) editTask(t.id, v);
      else if (!v) deleteTask(t.id);
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); }
    },
  }, t.text);

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
    },
    ondragend: () => {
      state.dragId = null;
      row.classList.remove("dragging");
      row.removeAttribute("draggable");
      clearDropIndicators();
    },
  }, handle, check, text, actions, caretRight);

  handle.addEventListener("mousedown", () => {
    row.setAttribute("draggable", "true");
    const cleanup = () => {
      if (state.dragId !== t.id) row.removeAttribute("draggable");
      document.removeEventListener("mouseup", cleanup);
    };
    document.addEventListener("mouseup", cleanup);
  });

  return row;
}

let composeInputRef: HTMLInputElement | null = null;

function renderTasks() {
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

  const body = el("div", { class: "settings" },
    el("label", {}, "Vault folder", folderRow),
    el("label", {}, "Global hotkey", hotkeyRow),
    stickyRow,
  );

  app.append(topbar, body);
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

  document.addEventListener("keydown", (e) => {
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
