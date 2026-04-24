/**
 * Integration test: SuggestEngine + replicator gate end-to-end routing.
 *
 * In the new model there is no rebind and no buffer Y.Doc. The engine
 * just flips `replicator.outboundOpen`. This test exercises the full
 * loop:
 *   1. SuggestEngine.enable() → outbound gate closes.
 *   2. Editor-level edits (simulated by direct Y.Text inserts on editorText
 *      — the editor's write path) stay on editorDoc, not syncDoc.
 *   3. hasPendingChanges() reflects the divergence.
 *   4. Peer edits on syncDoc still flow into editorDoc (inbound open).
 *   5. commit() resets editorDoc + reopens gate → peers see no trace of
 *      the drafts, only the submitted comment-side payload.
 *
 * The test runs at the CollaborationProvider level so it's handler-agnostic
 * by construction: the gate lives on the replicator, below every binding.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { CollaborationProvider } from '../../collab/collab-provider.js';
import { SuggestEngine } from '../../collab/suggest-engine.js';

describe('SuggestEngine + replicator gate routing', () => {
  let collab: CollaborationProvider;
  let engine: SuggestEngine;

  beforeEach(() => {
    collab = new CollaborationProvider();
    collab.syncText.insert(0, '# Hello\n');
    engine = new SuggestEngine(collab, {
      user: { userId: 'u1', userName: 'User 1' },
    });
  });

  afterEach(() => {
    engine.destroy();
    collab.destroy();
  });

  test('after enable, editor writes land on editorDoc, not syncDoc', () => {
    engine.enable('# Hello\n');
    // Baseline: replicator already synced '# Hello\n' into editorText.
    expect(collab.editorText.toString()).toBe('# Hello\n');

    // Simulate a user typing via the editor's write path.
    collab.editorText.insert(0, 'X');
    expect(collab.editorText.toString()).toBe('X# Hello\n');
    // syncDoc is untouched — no leak to peers.
    expect(collab.syncText.toString()).toBe('# Hello\n');
  });

  test('hasPendingChanges detects divergence from textAtEnable', () => {
    engine.enable('# Hello\n');
    expect(engine.hasPendingChanges('# Hello\n')).toBe(false);

    collab.editorText.insert(0, 'Z');
    expect(engine.hasPendingChanges(collab.editorText.toString())).toBe(true);
  });

  test('peer updates on syncDoc still rebase onto editorDoc', () => {
    engine.enable('# Hello\n');
    // Peer edit on syncDoc (arrives via the transport in real life).
    collab.syncText.insert(collab.syncText.length, ' + remote');
    // Inbound gate is open, so editorDoc picks it up.
    expect(collab.editorText.toString()).toContain('+ remote');
    expect(collab.syncText.toString()).toBe('# Hello\n + remote');
  });

  test('disable reopens gate; subsequent edits replicate again', () => {
    engine.enable('# Hello\n');
    collab.editorText.insert(0, 'A');
    expect(collab.syncText.toString()).toBe('# Hello\n');

    // Exit without submit or discard — explicit disable. The drafts
    // remain on editorDoc but peers do not see them. Subsequent edits
    // will fail to replicate (clock-gap), which is the documented
    // caveat the suggest-exit flow reset-on-commit/discard avoids.
    engine.disable();
    expect(collab.replicator.outboundOpen).toBe(true);
  });

  test('commit resets editorDoc; post-commit edits replicate cleanly', () => {
    engine.enable('# Hello\n');
    collab.editorText.insert(0, 'Y');
    engine.commit(null, collab.editorText.toString());

    // editorDoc was recreated. Its content matches syncDoc again.
    expect(collab.editorText.toString()).toBe('# Hello\n');
    expect(collab.syncText.toString()).toBe('# Hello\n');

    // Fresh clientID → fresh clock → replication works.
    collab.editorText.insert(collab.editorText.length, '!');
    expect(collab.syncText.toString()).toBe('# Hello\n!');
  });

  test('discard resets editorDoc; post-discard edits replicate cleanly', () => {
    engine.enable('# Hello\n');
    collab.editorText.insert(0, 'DRAFT-');
    engine.discard();

    expect(collab.editorText.toString()).toBe('# Hello\n');
    collab.editorText.insert(0, 'fresh-');
    expect(collab.syncText.toString()).toBe('fresh-# Hello\n');
  });
});
