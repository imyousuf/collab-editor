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

  test('renders user name', async () => {
    const el = createElement();
    el.userName = 'Alice';
    await waitUpdate(el);

    const user = el.shadowRoot!.querySelector('.user-name');
    expect(user).not.toBeNull();
    expect(user!.textContent).toContain('Alice');

    el.remove();
  });

  test('hides user name when empty', async () => {
    const el = createElement();
    el.userName = '';
    await waitUpdate(el);

    const user = el.shadowRoot!.querySelector('.user-name');
    expect(user).toBeNull();

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

    const user = el.shadowRoot!.querySelector('.user-name');
    expect(user).toBeNull();

    el.remove();
  });

  test('both status and user render together', async () => {
    const el = createElement();
    el.status = 'connected';
    el.userName = 'Charlie';
    await waitUpdate(el);

    expect(el.shadowRoot!.querySelector('.status-dot')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('.user-name')).not.toBeNull();

    el.remove();
  });
});
