/**
 * Source-level regression guard against re-introducing client-side
 * seeding in multi-editor.ts.
 *
 * Why this test exists
 * --------------------
 * Phase 1 moved initialContent seeding to the relay's server-side
 * Y.Doc: the relay applies a single synthetic Y.Text insert with a
 * pinned server ClientID, then ships that state to every peer via
 * SYNC_STEP_2. Clients no longer seed. Re-introducing a client-side
 * `sharedText.insert(0, initialContent)` would bring back the
 * content-doubling class of bugs we spent a lot of this branch
 * squashing (two peers, both see length=0 inside their settle window,
 * both insert, merge = 2× content).
 *
 * A full behavioral test would need Lit + a real WebSocket + a real
 * relay. That's the ATR browser test's job. This unit test is a cheap
 * static check that the forbidden pattern is absent from the source,
 * so a refactor doesn't silently regress the fix.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const multiEditorSrc = readFileSync(
  resolve(__dirname, '..', 'multi-editor.ts'),
  'utf8',
);

describe('multi-editor seeding guard', () => {
  test('does NOT seed initialContent into syncText or editorText on the client', () => {
    // Either form — the short method-chain or any variation — would
    // re-introduce the doubling bug.
    const forbidden = [
      /syncText\.insert\s*\(\s*0\s*,\s*config\.initialContent/,
      /syncText\.insert\s*\(\s*0\s*,\s*initial(Content)?\b/,
      /editorText\.insert\s*\(\s*0\s*,\s*config\.initialContent/,
      /editorText\.insert\s*\(\s*0\s*,\s*initial(Content)?\b/,
    ];
    for (const pattern of forbidden) {
      expect(multiEditorSrc).not.toMatch(pattern);
    }
  });

  test('does NOT import the decideSeed helper (deleted in Phase 1)', () => {
    // decideSeed lived in seed-decision.ts and was deleted alongside
    // the client-side seeding block. If it comes back, so does the
    // seeding decision logic it served.
    expect(multiEditorSrc).not.toMatch(/import.*decideSeed/);
    expect(multiEditorSrc).not.toMatch(/from\s+['"].*seed-decision/);
  });

  test('_performInit awaits whenSynced so SYNC_STEP_2 lands before editing', () => {
    // Sanity: we must still wait for the server's sync-step-2 before
    // the user can edit, otherwise they'd type against an empty
    // Y.Text and their edits would race the arriving server state.
    expect(multiEditorSrc).toMatch(/whenSynced\s*\(/);
  });
});
