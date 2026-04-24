import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { DocReplicator } from '../../collab/doc-replicator.js';

describe('DocReplicator', () => {
  let syncDoc: Y.Doc;
  let editorDoc: Y.Doc;
  let replicator: DocReplicator;

  beforeEach(() => {
    syncDoc = new Y.Doc();
    editorDoc = new Y.Doc();
    replicator = new DocReplicator(syncDoc, editorDoc);
  });

  afterEach(() => {
    replicator.destroy();
    syncDoc.destroy();
    editorDoc.destroy();
  });

  test('default gates are open', () => {
    expect(replicator.inboundOpen).toBe(true);
    expect(replicator.outboundOpen).toBe(true);
  });

  test('editor → sync propagates by default', () => {
    editorDoc.getText('source').insert(0, 'hello');
    expect(syncDoc.getText('source').toString()).toBe('hello');
  });

  test('sync → editor propagates by default', () => {
    syncDoc.getText('source').insert(0, 'world');
    expect(editorDoc.getText('source').toString()).toBe('world');
  });

  test('outboundOpen=false blocks editor → sync', () => {
    replicator.outboundOpen = false;
    editorDoc.getText('source').insert(0, 'local');
    expect(syncDoc.getText('source').toString()).toBe('');
  });

  test('outboundOpen=false still allows sync → editor', () => {
    replicator.outboundOpen = false;
    syncDoc.getText('source').insert(0, 'peer');
    expect(editorDoc.getText('source').toString()).toBe('peer');
  });

  test('inboundOpen=false blocks sync → editor', () => {
    replicator.inboundOpen = false;
    syncDoc.getText('source').insert(0, 'peer');
    expect(editorDoc.getText('source').toString()).toBe('');
  });

  test('inboundOpen=false still allows editor → sync', () => {
    replicator.inboundOpen = false;
    editorDoc.getText('source').insert(0, 'local');
    expect(syncDoc.getText('source').toString()).toBe('local');
  });

  test('CRDT clock continuity: edits made while outbound closed leave editorDoc ahead of syncDoc', () => {
    // This test documents a fundamental Yjs constraint the replicator does not
    // (and cannot) paper over: per-client clock sequences must be contiguous.
    // Once editorDoc has generated ops with its own clientID that syncDoc has
    // not seen, *any* subsequent local op — even after reverting and reopening
    // — carries a clock syncDoc cannot yet accept. The op queues as a pending
    // struct on syncDoc until the missing prefix arrives (which it never will,
    // because the gate was closed).
    //
    // Implication: the suggest-mode flow cannot simply "revert via undo + reopen"
    // on the same editorDoc. The caller must either (a) flush the full delta
    // on reopen (peers see tombstoned drafts appear-and-disappear), or (b)
    // rebuild editorDoc with a fresh clientID from syncDoc's state. The
    // SuggestEngine in C4 is responsible for choosing the strategy.
    syncDoc.getText('source').insert(0, 'base');
    const editorText = editorDoc.getText('source');
    const undoManager = new Y.UndoManager(editorText);

    replicator.outboundOpen = false;
    editorText.insert(4, '-draft');
    while (undoManager.canUndo()) undoManager.undo();
    expect(editorText.toString()).toBe('base');
    replicator.outboundOpen = true;

    // Subsequent local edit carries editorDoc's clientID at a clock syncDoc
    // has not seen a prefix for. It queues as pending, does not apply.
    editorText.insert(4, '!');
    expect(editorText.toString()).toBe('base!');
    expect(syncDoc.getText('source').toString()).toBe('base'); // stuck

    undoManager.destroy();
  });

  test('origin tag prevents feedback loop', () => {
    // Count updates on each doc. A feedback loop would manifest as repeated
    // updates bouncing back and forth.
    let syncUpdates = 0;
    let editorUpdates = 0;
    syncDoc.on('update', () => syncUpdates++);
    editorDoc.on('update', () => editorUpdates++);

    editorDoc.getText('source').insert(0, 'x');

    // Exactly one update per doc: the local insert on editorDoc, and the
    // mirrored apply on syncDoc. No second-order bounce.
    expect(editorUpdates).toBe(1);
    expect(syncUpdates).toBe(1);
  });

  test('seedEditorFromSync copies sync state into editor', () => {
    // Populate syncDoc first while the replicator is live (so editorDoc also
    // picks it up), then create a *fresh* editor doc and seed it.
    syncDoc.getText('source').insert(0, 'seeded');

    const freshEditor = new Y.Doc();
    const seeder = new DocReplicator(syncDoc, freshEditor);
    seeder.seedEditorFromSync();

    expect(freshEditor.getText('source').toString()).toBe('seeded');

    seeder.destroy();
    freshEditor.destroy();
  });

  test('destroy stops replication', () => {
    replicator.destroy();
    editorDoc.getText('source').insert(0, 'after-destroy');
    expect(syncDoc.getText('source').toString()).toBe('');

    syncDoc.getText('source').insert(0, 'also-after-destroy');
    expect(editorDoc.getText('source').toString()).toBe('after-destroy');
  });

  test('destroy is idempotent', () => {
    replicator.destroy();
    expect(() => replicator.destroy()).not.toThrow();
  });

  test('bidirectional convergence after a series of edits', () => {
    editorDoc.getText('source').insert(0, 'Hello ');
    syncDoc.getText('source').insert(6, 'World');
    editorDoc.getText('source').insert(11, '!');

    const expected = 'Hello World!';
    expect(editorDoc.getText('source').toString()).toBe(expected);
    expect(syncDoc.getText('source').toString()).toBe(expected);
  });

  test('outbound gate is a hard filter, not a buffer', () => {
    // Edits made while outbound is closed are NOT replayed when reopened.
    // The caller's responsibility (see suggest-mode flow test) is to revert
    // local edits via UndoManager before reopening the gate; otherwise
    // subsequent edits referencing closed-window items will fail to apply
    // on syncDoc due to missing causal dependencies.
    replicator.outboundOpen = false;
    editorDoc.getText('source').insert(0, 'draft');

    replicator.outboundOpen = true;
    expect(syncDoc.getText('source').toString()).toBe('');
    // editorDoc still has its local draft; reopening does not retroactively push.
    expect(editorDoc.getText('source').toString()).toBe('draft');
  });
});
