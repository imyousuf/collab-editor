import { describe, test, expect } from 'vitest';

// Import to register the custom element
import '../../toolbar/editor-status-bar.js';
import type { EditorStatusBar } from '../../toolbar/editor-status-bar.js';

function createElement(): EditorStatusBar {
  const el = document.createElement('editor-status-bar') as EditorStatusBar;
  document.body.appendChild(el);
  return el;
}

async function waitUpdate(el: EditorStatusBar) {
  await (el as any).updateComplete;
}

describe('EditorStatusBar', () => {
  test('renders disconnected status by default', async () => {
    const el = createElement();
    await waitUpdate(el);

    const dot = el.shadowRoot!.querySelector('.status-dot');
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains('disconnected')).toBe(true);

    const text = el.shadowRoot!.querySelector('.status-text');
    expect(text!.textContent).toBe('Disconnected');

    el.remove();
  });

  test('renders connected status', async () => {
    const el = createElement();
    el.status = 'connected';
    await waitUpdate(el);

    const dot = el.shadowRoot!.querySelector('.status-dot');
    expect(dot!.classList.contains('connected')).toBe(true);

    const text = el.shadowRoot!.querySelector('.status-text');
    expect(text!.textContent).toBe('Connected');

    el.remove();
  });

  test('renders connecting status', async () => {
    const el = createElement();
    el.status = 'connecting';
    await waitUpdate(el);

    const dot = el.shadowRoot!.querySelector('.status-dot');
    expect(dot!.classList.contains('connecting')).toBe(true);

    const text = el.shadowRoot!.querySelector('.status-text');
    expect(text!.textContent).toBe('Connecting...');

    el.remove();
  });

  test('renders user name with avatar initials', async () => {
    const el = createElement();
    el.userName = 'Alice Smith';
    el.userColor = '#e06c75';
    await waitUpdate(el);

    const user = el.shadowRoot!.querySelector('.user-label');
    expect(user).not.toBeNull();
    expect(user!.textContent).toBe('Alice Smith');

    const avatar = el.shadowRoot!.querySelector('.avatar');
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent!.trim()).toBe('AS');

    el.remove();
  });

  test('renders user avatar image when provided', async () => {
    const el = createElement();
    el.userName = 'Bob';
    el.userColor = '#61afef';
    el.userImage = 'https://example.com/bob.png';
    await waitUpdate(el);

    const img = el.shadowRoot!.querySelector('.avatar img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('bob.png');

    el.remove();
  });

  test('hides user name when empty', async () => {
    const el = createElement();
    el.userName = '';
    await waitUpdate(el);

    const user = el.shadowRoot!.querySelector('.user-label');
    expect(user).toBeNull();

    el.remove();
  });

  test('renders document name', async () => {
    const el = createElement();
    el.documentName = 'welcome.md';
    await waitUpdate(el);

    const docName = el.shadowRoot!.querySelector('.doc-name');
    expect(docName).not.toBeNull();
    expect(docName!.textContent).toBe('welcome.md');

    el.remove();
  });

  test('truncates long document path', async () => {
    const el = createElement();
    el.documentName = 'a/b/c/readme.md';
    await waitUpdate(el);

    const docName = el.shadowRoot!.querySelector('.doc-name');
    expect(docName!.textContent).toContain('readme.md');
    // Should have ellipsis prefix
    expect(docName!.textContent).toContain('\u2026');

    el.remove();
  });

  test('renders collaborator avatars', async () => {
    const el = createElement();
    el.collaborators = [
      { name: 'Alice', color: '#e06c75' },
      { name: 'Bob', color: '#61afef', image: 'https://example.com/bob.png' },
    ];
    await waitUpdate(el);

    const avatars = el.shadowRoot!.querySelectorAll('.collab-avatars .avatar');
    expect(avatars.length).toBe(2);
    // First is initials, second has image
    expect(avatars[0].textContent!.trim()).toBe('A');
    expect(avatars[1].querySelector('img')).not.toBeNull();

    el.remove();
  });

  test('hides collaborators when empty', async () => {
    const el = createElement();
    el.collaborators = [];
    await waitUpdate(el);

    const collabs = el.shadowRoot!.querySelector('.collab-avatars');
    expect(collabs).toBeNull();

    el.remove();
  });

  test('config.showConnectionStatus false hides status', async () => {
    const el = createElement();
    el.config = { showConnectionStatus: false };
    await waitUpdate(el);

    const dot = el.shadowRoot!.querySelector('.status-dot');
    expect(dot).toBeNull();

    el.remove();
  });

  test('config.showUserIdentity false hides user', async () => {
    const el = createElement();
    el.userName = 'Bob';
    el.config = { showUserIdentity: false };
    await waitUpdate(el);

    const user = el.shadowRoot!.querySelector('.user-label');
    expect(user).toBeNull();

    el.remove();
  });

  test('config.showPresence false hides collaborators', async () => {
    const el = createElement();
    el.collaborators = [{ name: 'Alice', color: '#e06c75' }];
    el.config = { showPresence: false };
    await waitUpdate(el);

    const collabs = el.shadowRoot!.querySelector('.collab-avatars');
    expect(collabs).toBeNull();

    el.remove();
  });

  test('both status and user render together', async () => {
    const el = createElement();
    el.status = 'connected';
    el.userName = 'Charlie';
    el.userColor = '#98c379';
    await waitUpdate(el);

    expect(el.shadowRoot!.querySelector('.status-dot')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('.user-label')).not.toBeNull();

    el.remove();
  });

  test('shows version section with save button when versionsAvailable', async () => {
    const el = createElement();
    el.versionsAvailable = true;
    el.versionCount = 0;
    await waitUpdate(el);

    // Should show "Versions" text (no count) and a Save button
    const indicator = el.shadowRoot!.querySelector('.version-indicator');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain('Versions');

    const saveBtn = el.shadowRoot!.querySelector('.version-save-btn');
    expect(saveBtn).not.toBeNull();

    el.remove();
  });

  test('version quick-save button dispatches version-quick-save event', async () => {
    const el = createElement();
    el.versionsAvailable = true;
    el.versionCount = 3;
    await waitUpdate(el);

    let fired = false;
    el.addEventListener('version-quick-save', () => { fired = true; });

    const saveBtn = el.shadowRoot!.querySelector('.version-save-btn') as HTMLElement;
    saveBtn?.click();

    expect(fired).toBe(true);

    el.remove();
  });

  test('version count shows correct text', async () => {
    const el = createElement();
    el.versionsAvailable = true;
    el.versionCount = 1;
    await waitUpdate(el);

    const indicator = el.shadowRoot!.querySelector('.version-indicator');
    expect(indicator?.textContent).toContain('1 version');
    expect(indicator?.textContent).not.toContain('versions');

    el.versionCount = 5;
    await waitUpdate(el);
    expect(indicator?.textContent).toContain('5 versions');

    el.remove();
  });
});
