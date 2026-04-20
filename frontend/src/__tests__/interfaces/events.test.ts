import { describe, test, expect } from 'vitest';
import {
  EditorChangeEvent,
  ModeChangeEvent,
  EditorSaveEvent,
  CollabStatusEvent,
  RemoteChangeEvent,
} from '../../interfaces/events.js';

describe('EditorChangeEvent', () => {
  test('has correct event type', () => {
    const event = new EditorChangeEvent({ value: 'test', format: 'html', mode: 'source' });
    expect(event.type).toBe('editor-change');
  });

  test('carries detail with value, format, mode', () => {
    const event = new EditorChangeEvent({ value: '<p>hi</p>', format: 'html', mode: 'wysiwyg' });
    expect(event.detail.value).toBe('<p>hi</p>');
    expect(event.detail.format).toBe('html');
    expect(event.detail.mode).toBe('wysiwyg');
  });

  test('bubbles and is composed', () => {
    const event = new EditorChangeEvent({ value: '', format: 'markdown', mode: 'source' });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });
});

describe('ModeChangeEvent', () => {
  test('has correct event type', () => {
    const event = new ModeChangeEvent({ mode: 'wysiwyg', previousMode: 'source' });
    expect(event.type).toBe('mode-change');
  });

  test('carries detail with mode and previousMode', () => {
    const event = new ModeChangeEvent({ mode: 'preview', previousMode: 'source' });
    expect(event.detail.mode).toBe('preview');
    expect(event.detail.previousMode).toBe('source');
  });

  test('bubbles and is composed', () => {
    const event = new ModeChangeEvent({ mode: 'source', previousMode: 'wysiwyg' });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });
});

describe('EditorSaveEvent', () => {
  test('has correct event type', () => {
    const event = new EditorSaveEvent({ value: 'content', format: 'markdown' });
    expect(event.type).toBe('editor-save');
  });

  test('carries detail with value and format', () => {
    const event = new EditorSaveEvent({ value: '# heading', format: 'markdown' });
    expect(event.detail.value).toBe('# heading');
    expect(event.detail.format).toBe('markdown');
  });

  test('bubbles and is composed', () => {
    const event = new EditorSaveEvent({ value: '', format: 'html' });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });
});

describe('CollabStatusEvent', () => {
  test('has correct event type', () => {
    const event = new CollabStatusEvent({ status: 'connected' });
    expect(event.type).toBe('collab-status');
  });

  test('carries detail with status', () => {
    const event = new CollabStatusEvent({ status: 'connecting' });
    expect(event.detail.status).toBe('connecting');
  });

  test('all status values work', () => {
    for (const status of ['connected', 'connecting', 'disconnected'] as const) {
      const event = new CollabStatusEvent({ status });
      expect(event.detail.status).toBe(status);
    }
  });

  test('bubbles and is composed', () => {
    const event = new CollabStatusEvent({ status: 'disconnected' });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });
});

describe('RemoteChangeEvent', () => {
  test('has correct event type', () => {
    const event = new RemoteChangeEvent({ peerId: 'peer-1', changeType: 'insert' });
    expect(event.type).toBe('remote-change');
  });

  test('carries detail with peerId and changeType', () => {
    const event = new RemoteChangeEvent({ peerId: 'peer-2', changeType: 'delete' });
    expect(event.detail.peerId).toBe('peer-2');
    expect(event.detail.changeType).toBe('delete');
  });

  test('all change types work', () => {
    for (const changeType of ['insert', 'delete', 'update'] as const) {
      const event = new RemoteChangeEvent({ peerId: 'p', changeType });
      expect(event.detail.changeType).toBe(changeType);
    }
  });

  test('bubbles and is composed', () => {
    const event = new RemoteChangeEvent({ peerId: 'p', changeType: 'update' });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });
});
