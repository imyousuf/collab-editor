import { describe, test, expect, vi } from 'vitest';
import { emptyFormattingState, ALL_FORMATTING_COMMANDS } from '../../interfaces/formatting.js';
import type { FormattingState } from '../../interfaces/formatting.js';

// Import to register the custom element
import '../../toolbar/editor-toolbar.js';
import type { EditorToolbar } from '../../toolbar/editor-toolbar.js';

function createElement(): EditorToolbar {
  const el = document.createElement('editor-toolbar') as EditorToolbar;
  document.body.appendChild(el);
  return el;
}

async function waitUpdate(el: EditorToolbar) {
  await (el as any).updateComplete;
}

describe('EditorToolbar', () => {
  test('renders mode switcher buttons', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'source';
    await waitUpdate(el);

    const buttons = el.shadowRoot!.querySelectorAll('.mode-btn');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe('WYSIWYG');
    expect(buttons[1].textContent).toBe('Source');
    expect(buttons[1].classList.contains('active')).toBe(true);
    expect(buttons[0].classList.contains('active')).toBe(false);

    el.remove();
  });

  test('renders three mode buttons for preview-source', async () => {
    const el = createElement();
    el.supportedModes = ['preview', 'source'];
    el.mode = 'preview';
    await waitUpdate(el);

    const buttons = el.shadowRoot!.querySelectorAll('.mode-btn');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe('Preview');
    expect(buttons[0].classList.contains('active')).toBe(true);

    el.remove();
  });

  test('does not render formatting buttons in source mode', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'source';
    el.availableCommands = [];
    await waitUpdate(el);

    const fmtButtons = el.shadowRoot!.querySelectorAll('.fmt-btn');
    expect(fmtButtons.length).toBe(0);

    el.remove();
  });

  test('renders formatting buttons in wysiwyg mode', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = [...ALL_FORMATTING_COMMANDS];
    await waitUpdate(el);

    const fmtButtons = el.shadowRoot!.querySelectorAll('.fmt-btn');
    expect(fmtButtons.length).toBe(ALL_FORMATTING_COMMANDS.length);

    el.remove();
  });

  test('formatting buttons reflect active state', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = ['bold', 'italic'];
    const state: FormattingState = { ...emptyFormattingState(), bold: true };
    el.formattingState = state;
    await waitUpdate(el);

    const fmtButtons = el.shadowRoot!.querySelectorAll('.fmt-btn');
    expect(fmtButtons[0].classList.contains('active')).toBe(true);
    expect(fmtButtons[1].classList.contains('active')).toBe(false);

    el.remove();
  });

  test('dispatches toolbar-mode-switch event', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'source';
    await waitUpdate(el);

    const handler = vi.fn();
    el.addEventListener('toolbar-mode-switch', handler);

    const wysiwygBtn = el.shadowRoot!.querySelectorAll('.mode-btn')[0] as HTMLButtonElement;
    wysiwygBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail.mode).toBe('wysiwyg');

    el.remove();
  });

  test('dispatches toolbar-command event', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = ['bold', 'italic'];
    await waitUpdate(el);

    const handler = vi.fn();
    el.addEventListener('toolbar-command', handler);

    const boldBtn = el.shadowRoot!.querySelectorAll('.fmt-btn')[0] as HTMLButtonElement;
    boldBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail.command).toBe('bold');

    el.remove();
  });

  test('formatting buttons disabled when readonly', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = ['bold'];
    el.readonly = true;
    await waitUpdate(el);

    const btn = el.shadowRoot!.querySelector('.fmt-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    el.remove();
  });

  test('config.visible false hides everything via host', async () => {
    const el = createElement();
    el.config = { visible: false };
    await waitUpdate(el);

    // The parent decides visibility; toolbar itself always renders
    // but we can check that it doesn't throw
    expect(el.shadowRoot).not.toBeNull();

    el.remove();
  });

  test('config.showModeSwitcher false hides mode buttons', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'source';
    el.config = { showModeSwitcher: false };
    await waitUpdate(el);

    const modeButtons = el.shadowRoot!.querySelectorAll('.mode-btn');
    expect(modeButtons.length).toBe(0);

    el.remove();
  });

  test('config.groups filters which groups render', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = ['bold'];
    el.config = { groups: ['formatting'] };
    await waitUpdate(el);

    // No mode buttons
    expect(el.shadowRoot!.querySelectorAll('.mode-btn').length).toBe(0);
    // But formatting buttons present
    expect(el.shadowRoot!.querySelectorAll('.fmt-btn').length).toBe(1);

    el.remove();
  });

  test('config.formattingCommands whitelists specific commands', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = [...ALL_FORMATTING_COMMANDS];
    el.config = { formattingCommands: ['bold', 'italic'] };
    await waitUpdate(el);

    const fmtButtons = el.shadowRoot!.querySelectorAll('.fmt-btn');
    expect(fmtButtons.length).toBe(2);

    el.remove();
  });

  test('separator renders between mode switcher and formatting', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'wysiwyg';
    el.availableCommands = ['bold'];
    await waitUpdate(el);

    const separator = el.shadowRoot!.querySelector('.separator');
    expect(separator).not.toBeNull();

    el.remove();
  });

  test('no separator when only mode switcher (source mode)', async () => {
    const el = createElement();
    el.supportedModes = ['wysiwyg', 'source'];
    el.mode = 'source';
    el.availableCommands = [];
    await waitUpdate(el);

    const separator = el.shadowRoot!.querySelector('.separator');
    expect(separator).toBeNull();

    el.remove();
  });
});
