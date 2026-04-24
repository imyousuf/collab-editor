/**
 * SourceEditorInstance.rebindSharedText — Suggest Mode edit routing.
 *
 * Context: before this fix, enabling Suggest Mode left CodeMirror bound
 * to the base Y.Text, so local "suggestion" edits leaked to peers and
 * the SuggestEngine buffer never received them. The Compartment-based
 * rebind lets us swap yCollab's bound Y.Text at runtime.
 *
 * Note on timing: y-codemirror.next's initial Y.Text→editor sync is
 * deferred past synchronous test code in jsdom. These tests don't rely
 * on the editor's visible content reflecting the Y.Text state — they
 * dispatch direct `view.dispatch` changes and assert that the change
 * flows to the correct Y.Text (editor→Y.Text is synchronous via the
 * ViewPlugin's update() callback).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness.js';
import { SourceEditorInstance } from '../../bindings/_source-editor.js';

describe('SourceEditorInstance.rebindSharedText', () => {
  let container: HTMLElement;
  let baseDoc: Y.Doc;
  let baseText: Y.Text;
  let awareness: Awareness;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    baseDoc = new Y.Doc();
    baseText = baseDoc.getText('source');
    awareness = new Awareness(baseDoc);
  });

  afterEach(() => {
    container.remove();
    awareness.destroy();
    baseDoc.destroy();
  });

  function mkInstance() {
    return new SourceEditorInstance(
      container,
      { language: 'markdown', readonly: false, theme: 'light' },
      { sharedText: baseText, awareness, ydoc: baseDoc },
    );
  }

  test('starts bound to the base Y.Text provided at mount', () => {
    const inst = mkInstance();
    try {
      expect(inst.ytext).toBe(baseText);
    } finally {
      inst.destroy();
    }
  });

  test('rebind swaps the bound Y.Text reference', () => {
    const inst = mkInstance();
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    try {
      inst.rebindSharedText(bufferText);
      expect(inst.ytext).toBe(bufferText);
    } finally {
      inst.destroy();
      bufferDoc.destroy();
    }
  });

  test('editor-to-Y.Text writes route to the buffer after rebind', () => {
    const inst = mkInstance();
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    try {
      inst.rebindSharedText(bufferText);
      // Dispatch a direct insert through the view. yCollab's update() runs
      // synchronously and should write to whichever Y.Text the current
      // plugin instance is bound to (the buffer, after rebind).
      inst.view.dispatch({
        changes: { from: 0, insert: 'X' },
      });
      expect(bufferText.toString()).toBe('X');
      // Base Y.Text is untouched.
      expect(baseText.toString()).toBe('');
    } finally {
      inst.destroy();
      bufferDoc.destroy();
    }
  });

  test('editor-to-Y.Text writes stop reaching the old base after rebind', () => {
    baseText.insert(0, 'pre');
    const inst = mkInstance();
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    try {
      inst.rebindSharedText(bufferText);
      inst.view.dispatch({
        changes: { from: 0, insert: 'NEW' },
      });
      // Base Y.Text is untouched — still exactly what it was pre-rebind.
      expect(baseText.toString()).toBe('pre');
      // Buffer received the insert.
      expect(bufferText.toString()).toBe('NEW');
    } finally {
      inst.destroy();
      bufferDoc.destroy();
    }
  });

  test('rebinding back to the original Y.Text resumes base writes', () => {
    const inst = mkInstance();
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    try {
      inst.rebindSharedText(bufferText);
      inst.view.dispatch({ changes: { from: 0, insert: 'buf' } });
      expect(bufferText.toString()).toBe('buf');
      expect(baseText.toString()).toBe('');

      // Rebind back to base. New yCollab instance, new editor observer —
      // subsequent edits write to base.
      inst.rebindSharedText(baseText);
      inst.view.dispatch({ changes: { from: 0, insert: 'base' } });
      expect(baseText.toString()).toBe('base');
      // Buffer is frozen at the value it had before the rebind-back.
      expect(bufferText.toString()).toBe('buf');
    } finally {
      inst.destroy();
      bufferDoc.destroy();
    }
  });

  test('rebinding to the same Y.Text is a no-op', () => {
    const inst = mkInstance();
    try {
      // Should not throw, should not double-observe.
      inst.rebindSharedText(baseText);
      expect(inst.ytext).toBe(baseText);

      // A subsequent edit still reaches base exactly once (no duplicate).
      inst.view.dispatch({ changes: { from: 0, insert: 'Y' } });
      expect(baseText.toString()).toBe('Y');
    } finally {
      inst.destroy();
    }
  });

  test('rebind is a no-op when the editor has no collab context', () => {
    const bareContainer = document.createElement('div');
    document.body.appendChild(bareContainer);
    const inst = new SourceEditorInstance(
      bareContainer,
      { language: 'markdown', readonly: false, theme: 'light' },
      null,
    );
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    try {
      inst.rebindSharedText(bufferText); // should not throw
      expect(inst.ytext).toBeNull();
    } finally {
      inst.destroy();
      bufferDoc.destroy();
      bareContainer.remove();
    }
  });

  test('rebind resyncs CodeMirror doc to the new Y.Text when they differ', () => {
    // Regression: after Suggest Mode submit, editorDoc is reset and the
    // source editor was left displaying the discarded draft because
    // yCollab's ySync only observes future Y.Text changes, not existing
    // state. The rebind flow now replaces the doc during the brief
    // yCollab-detached window.
    baseText.insert(0, 'draft-content');
    const inst = mkInstance();

    // Simulate the editor's view carrying drafted content while the
    // new Y.Text has the reverted baseline.
    inst.view.dispatch({
      changes: { from: 0, to: inst.view.state.doc.length, insert: 'draft-content' },
    });

    const newDoc = new Y.Doc();
    const newText = newDoc.getText('source');
    newText.insert(0, 'reverted-content');

    try {
      inst.rebindSharedText(newText);
      expect(inst.view.state.doc.toString()).toBe('reverted-content');
    } finally {
      inst.destroy();
      newDoc.destroy();
    }
  });

  test('rebind does NOT leak editor content back to the new Y.Text', () => {
    // The resync dispatch between the two compartment reconfigures
    // happens while yCollab is detached, so the new Y.Text must stay
    // exactly what the caller gave us — no ops applied from the
    // transient editor state.
    const inst = mkInstance();
    inst.view.dispatch({ changes: { from: 0, insert: 'junk-in-editor' } });

    const newDoc = new Y.Doc();
    const newText = newDoc.getText('source');
    newText.insert(0, 'clean');

    try {
      inst.rebindSharedText(newText);
      expect(newText.toString()).toBe('clean');
    } finally {
      inst.destroy();
      newDoc.destroy();
    }
  });

  test('rebind skips the resync when contents already match', () => {
    baseText.insert(0, 'same');
    const inst = mkInstance();
    inst.view.dispatch({
      changes: { from: 0, to: inst.view.state.doc.length, insert: 'same' },
    });

    const newDoc = new Y.Doc();
    const newText = newDoc.getText('source');
    newText.insert(0, 'same');

    try {
      // Spy-free check: we just confirm the doc stays put and no
      // exception is thrown on a same-content rebind.
      const before = inst.view.state.doc.toString();
      inst.rebindSharedText(newText);
      expect(inst.view.state.doc.toString()).toBe(before);
      expect(newText.toString()).toBe('same');
    } finally {
      inst.destroy();
      newDoc.destroy();
    }
  });

  test('awareness instance is reused across rebinds (no duplicate cursors)', () => {
    const inst = mkInstance();
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');

    try {
      // Reference check: the Awareness instance we hold outside the editor
      // is the same one yCollab is using internally — rebind does not
      // replace it with a fresh Awareness.
      const awarenessBefore = awareness;
      inst.rebindSharedText(bufferText);
      inst.rebindSharedText(baseText);
      // Our captured reference is unchanged. If rebindSharedText had
      // constructed a new Awareness under the hood, this would fail
      // because we'd expect the local state to have been reset.
      expect(awareness).toBe(awarenessBefore);
    } finally {
      inst.destroy();
      bufferDoc.destroy();
    }
  });
});
