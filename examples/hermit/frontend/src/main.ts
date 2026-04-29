// Side-effect import registers the <multi-editor> custom element.
import '@imyousuf/collab-editor';

interface FileResult {
  path: string;
  name: string;
  content: string;
  mimeType: string;
}

declare global {
  interface Window {
    go: {
      main: {
        App: {
          OpenFile(): Promise<FileResult>;
          LoadFile(path: string): Promise<FileResult>;
          SaveFile(path: string, content: string): Promise<void>;
          SaveFileAs(suggestedName: string, content: string): Promise<FileResult>;
        };
      };
    };
  }
}

interface MultiEditorElement extends HTMLElement {
  mimeType: string;
  mode: 'wysiwyg' | 'source' | 'preview';
  initialContent: string;
  collaboration: unknown;
  readonly updateComplete: Promise<boolean>;
  readonly whenReady: Promise<void>;
  readonly whenInit: Promise<void>;
  getContent(): string;
  setContent(text: string): void;
}

interface Tab {
  id: string;
  path: string;        // '' for unsaved
  name: string;        // basename or 'Untitled'
  content: string;     // current editor content
  savedContent: string;
  mimeType: string;
}

const editor = document.getElementById('editor') as MultiEditorElement;
const emptyStateEl = document.getElementById('empty-state')!;
const tabBarEl = document.getElementById('tab-bar')!;
const pathnameEl = document.getElementById('pathname')!;
const toastEl = document.getElementById('toast')!;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnSaveAs = document.getElementById('btn-save-as') as HTMLButtonElement;
const btnClose = document.getElementById('btn-close') as HTMLButtonElement;

let tabs: Tab[] = [];
let activeTabId: string | null = null;
// Suppress editor-change → tab.content writes during programmatic updates
// (tab switch, file load). The component's onContentChange fires
// asynchronously after setContent, and we don't want to mark dirty or
// overwrite the new tab with the old tab's content.
let suppressEditorEvents = false;
let nextTabId = 1;

function newTabId(): string {
  return `t${nextTabId++}`;
}

function getActive(): Tab | null {
  return tabs.find(t => t.id === activeTabId) ?? null;
}

function isDirty(t: Tab): boolean {
  return t.content !== t.savedContent;
}

function toast(msg: string, ms = 1500): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), ms);
}

function refreshChrome(): void {
  const active = getActive();
  if (active) {
    pathnameEl.textContent = active.path || '(unsaved)';
    document.title = `${isDirty(active) ? '* ' : ''}${active.name} — Hermit`;
    editor.hidden = false;
    emptyStateEl.style.display = 'none';
  } else {
    pathnameEl.textContent = '';
    document.title = 'Hermit';
    editor.hidden = true;
    emptyStateEl.style.display = '';
  }
  btnSave.disabled = !active;
  btnSaveAs.disabled = !active;
  btnClose.disabled = !active;
  renderTabs();
}

function renderTabs(): void {
  tabBarEl.innerHTML = '';
  if (tabs.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'empty-hint';
    hint.textContent = 'No tabs open';
    tabBarEl.appendChild(hint);
    return;
  }
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.title = tab.path || '(unsaved)';
    el.addEventListener('click', () => switchTab(tab.id));

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.name;
    el.appendChild(name);

    if (isDirty(tab)) {
      const dot = document.createElement('span');
      dot.className = 'dirty-dot';
      el.appendChild(dot);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(close);

    tabBarEl.appendChild(el);
  }

  const newBtn = document.createElement('button');
  newBtn.className = 'new-tab-btn';
  newBtn.textContent = '+';
  newBtn.title = 'New tab (Ctrl+N)';
  newBtn.addEventListener('click', () => doNew());
  tabBarEl.appendChild(newBtn);
}

// Load `tab` into the live editor. Snapshot the previously-active tab's
// content first so any in-flight typing isn't lost on switch.
async function activateTab(tab: Tab): Promise<void> {
  // Snapshot whatever's in the editor right now into the *outgoing* tab.
  const outgoing = getActive();
  if (outgoing && outgoing.id !== tab.id) {
    outgoing.content = editor.getContent();
  }

  activeTabId = tab.id;
  refreshChrome();

  suppressEditorEvents = true;
  try {
    if (editor.mimeType !== tab.mimeType) {
      // mimeType change forces a binding remount; seed via initialContent.
      editor.initialContent = tab.content;
      editor.mimeType = tab.mimeType;
      await editor.updateComplete;
      await editor.whenInit;
    } else {
      await editor.whenReady;
      editor.setContent(tab.content);
    }
  } finally {
    suppressEditorEvents = false;
  }
  refreshChrome();
}

async function switchTab(id: string): Promise<void> {
  if (id === activeTabId) return;
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  await activateTab(tab);
}

async function confirmDiscardIfDirty(tab: Tab): Promise<boolean> {
  if (!isDirty(tab)) return true;
  return window.confirm(`Discard unsaved changes in ${tab.name}?`);
}

async function doNew(): Promise<void> {
  const tab: Tab = {
    id: newTabId(),
    path: '',
    name: 'Untitled',
    content: '',
    savedContent: '',
    mimeType: 'text/markdown',
  };
  tabs.push(tab);
  await activateTab(tab);
}

async function doOpen(): Promise<void> {
  let file: FileResult;
  try {
    file = await window.go.main.App.OpenFile();
  } catch (err) {
    toast(`Open failed: ${err}`);
    return;
  }
  if (!file.path) return; // user cancelled
  await openFile(file);
}

async function openFile(file: FileResult): Promise<void> {
  // Already open? Just switch to it. Path-equality is the de-dup key
  // because that's what the user means by "the same file".
  const existing = tabs.find(t => t.path && t.path === file.path);
  if (existing) {
    await switchTab(existing.id);
    toast(`Switched to ${file.name}`);
    return;
  }
  const tab: Tab = {
    id: newTabId(),
    path: file.path,
    name: file.name,
    content: file.content,
    savedContent: file.content,
    mimeType: file.mimeType,
  };
  tabs.push(tab);
  await activateTab(tab);
  toast(`Opened ${file.name}`);
}

async function doSave(): Promise<void> {
  const tab = getActive();
  if (!tab) return;
  // Snapshot the live editor first — content tracked on tab is already
  // updated by editor-change, but pulling directly avoids a stale-by-one-tick
  // race after rapid typing.
  tab.content = editor.getContent();
  if (!tab.path) {
    await doSaveAs();
    return;
  }
  try {
    await window.go.main.App.SaveFile(tab.path, tab.content);
    tab.savedContent = tab.content;
    refreshChrome();
    toast(`Saved ${tab.name}`);
  } catch (err) {
    toast(`Save failed: ${err}`);
  }
}

async function doSaveAs(): Promise<void> {
  const tab = getActive();
  if (!tab) return;
  tab.content = editor.getContent();
  let file: FileResult;
  try {
    file = await window.go.main.App.SaveFileAs(tab.name, tab.content);
  } catch (err) {
    toast(`Save failed: ${err}`);
    return;
  }
  if (!file.path) return; // cancelled
  tab.path = file.path;
  tab.name = file.name;
  tab.savedContent = tab.content;
  // The new path's MIME may differ — remount only if it changed.
  if (tab.mimeType !== file.mimeType) {
    tab.mimeType = file.mimeType;
    await activateTab(tab);
  }
  refreshChrome();
  toast(`Saved as ${file.name}`);
}

async function closeTab(id: string): Promise<void> {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  // For the active tab, capture latest content before checking dirty.
  if (tab.id === activeTabId) {
    tab.content = editor.getContent();
  }
  if (!(await confirmDiscardIfDirty(tab))) return;
  tabs.splice(idx, 1);
  if (tab.id === activeTabId) {
    // Prefer right-side neighbor, then left, then nothing.
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    if (next) {
      await activateTab(next);
    } else {
      activeTabId = null;
      refreshChrome();
    }
  } else {
    refreshChrome();
  }
}

async function doCloseActive(): Promise<void> {
  if (activeTabId) await closeTab(activeTabId);
}

// Wire menu buttons
document.getElementById('btn-new')!.addEventListener('click', doNew);
document.getElementById('btn-open')!.addEventListener('click', doOpen);
document.getElementById('btn-save')!.addEventListener('click', doSave);
document.getElementById('btn-save-as')!.addEventListener('click', doSaveAs);
document.getElementById('btn-close')!.addEventListener('click', doCloseActive);

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); doNew(); }
  else if (k === 'o') { e.preventDefault(); doOpen(); }
  else if (k === 's' && e.shiftKey) { e.preventDefault(); doSaveAs(); }
  else if (k === 's') { e.preventDefault(); doSave(); }
  else if (k === 'w') { e.preventDefault(); doCloseActive(); }
});

// Track edits → update active tab's working copy and re-render to
// reflect the dirty dot.
editor.addEventListener('editor-change', (e: Event) => {
  if (suppressEditorEvents) return;
  const tab = getActive();
  if (!tab) return;
  const ce = e as CustomEvent<{ value: string }>;
  const wasDirty = isDirty(tab);
  tab.content = ce.detail.value;
  if (wasDirty !== isDirty(tab)) renderTabs();
});

window.addEventListener('beforeunload', (e) => {
  // Pull the latest from the editor into the active tab so its dirty
  // state reflects post-typing reality.
  const active = getActive();
  if (active) active.content = editor.getContent();
  if (tabs.some(isDirty)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Bootstrap with one Untitled tab.
doNew();
