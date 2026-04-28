/**
 * @vitest-environment jsdom
 */
import { describe, test, expect } from 'vitest';
import '../../toolbar/comment-panel.js';
import '../../toolbar/suggest-status.js';
import type { CommentPanel } from '../../toolbar/comment-panel.js';
import type { SuggestStatus } from '../../toolbar/suggest-status.js';
import type { CommentThread } from '../../interfaces/comments.js';

function makeThread(partial: Partial<CommentThread> = {}): CommentThread {
  return {
    id: partial.id ?? 't1',
    document_id: 'doc.md',
    anchor: partial.anchor ?? { start: 0, end: 5, quoted_text: 'hello' },
    status: partial.status ?? 'open',
    created_at: '2026-01-01T00:00:00Z',
    comments: partial.comments ?? [
      {
        id: 'c1',
        thread_id: partial.id ?? 't1',
        author_id: 'u1',
        author_name: 'Alice',
        content: 'hey there',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    suggestion: partial.suggestion,
  };
}

async function mountPanel(overrides: Partial<CommentPanel> = {}): Promise<CommentPanel> {
  const el = document.createElement('comment-panel') as CommentPanel;
  Object.assign(el, overrides);
  document.body.appendChild(el);
  el.open = true;
  await (el as any).updateComplete;
  return el;
}

describe('comment-panel', () => {
  test('renders quoted text and comment body', async () => {
    const panel = await mountPanel({ thread: makeThread() });
    const quote = panel.shadowRoot!.querySelector('.header-quote')!;
    expect(quote.textContent).toContain('hello');
    const body = panel.shadowRoot!.querySelector('.comment-body');
    expect(body?.textContent).toContain('hey there');
  });

  test('sending a reply dispatches comment-reply event', async () => {
    const panel = await mountPanel({ thread: makeThread() });
    let received: any = null;
    panel.addEventListener('comment-reply', (e: any) => {
      received = e.detail;
    });

    const textarea = panel.shadowRoot!.querySelector('textarea')!;
    textarea.value = 'hi back';
    textarea.dispatchEvent(new Event('input'));
    await (panel as any).updateComplete;

    const sendBtn = panel.shadowRoot!.querySelector('.reply-actions .primary') as HTMLButtonElement;
    sendBtn.click();

    expect(received?.content).toBe('hi back');
    expect(received?.threadId).toBe('t1');
  });

  test('resolve button dispatches comment-thread-resolve', async () => {
    const panel = await mountPanel({ thread: makeThread() });
    let received: any = null;
    panel.addEventListener('comment-thread-resolve', (e: any) => {
      received = e.detail;
    });
    const btn = panel.shadowRoot!.querySelector('.actions .primary') as HTMLButtonElement;
    btn.click();
    expect(received?.threadId).toBe('t1');
  });

  test('resolved thread hides reply box, no primary action, Reopen is a deliberate footer link', async () => {
    // Earlier design had "Reopen" as the primary button right next to the
    // close ×. Users misclicked it — activating a resolved thread from
    // the status-bar list appeared to "bring the highlight back" because
    // one stray click reopened the thread. Now: resolved threads are
    // read-only by default; Reopen is a text link in the footer behind a
    // confirm() prompt.
    const panel = await mountPanel({ thread: makeThread({ status: 'resolved' }) });
    expect(panel.shadowRoot!.querySelector('textarea')).toBeNull();
    // No primary action — headers only have the delete + close.
    expect(panel.shadowRoot!.querySelector('.actions .primary')).toBeNull();
    const reopenLink = panel.shadowRoot!.querySelector('.reopen-link');
    expect(reopenLink).not.toBeNull();
    expect(reopenLink!.textContent).toContain('Reopen thread');
  });

  test('clicking Reopen link dispatches reopen only after confirm() passes', async () => {
    const panel = await mountPanel({ thread: makeThread({ status: 'resolved' }) });
    let dispatched: any = null;
    panel.addEventListener('comment-thread-reopen', (e: any) => { dispatched = e.detail; });

    const originalConfirm = window.confirm;
    try {
      // User cancels: no reopen.
      (window as any).confirm = () => false;
      (panel.shadowRoot!.querySelector('.reopen-link') as HTMLButtonElement).click();
      expect(dispatched).toBeNull();

      // User confirms: reopen fires with the thread id.
      (window as any).confirm = () => true;
      (panel.shadowRoot!.querySelector('.reopen-link') as HTMLButtonElement).click();
      expect(dispatched?.threadId).toBe('t1');
    } finally {
      (window as any).confirm = originalConfirm;
    }
  });

  test('suggestion section renders summary + author + Accept/Reject (diff body lives in multi-editor)', async () => {
    // The side-by-side diff used to be rendered inside this 360px popover,
    // which was too cramped for a document-wide diff. It now lives in
    // multi-editor's full-width suggestion-diff-bar, so the panel only
    // shows summary + metadata + actions.
    const panel = await mountPanel({
      thread: makeThread({
        suggestion: {
          yjs_payload: 'AAA=',
          human_readable: {
            summary: 'Change "hello" to "HELLO"',
            before_text: 'hello',
            after_text: 'HELLO',
            operations: [],
          },
          author_id: 'u1',
          author_name: 'Alice',
          status: 'pending',
        },
      }),
      capabilities: {
        comment_edit: false,
        comment_delete: false,
        reactions: [],
        mentions: false,
        suggestions: true,
        max_comment_size: 10240,
        poll_supported: false,
      },
    });

    // Summary + author metadata are in the panel.
    const summary = panel.shadowRoot!.querySelector('.suggestion-summary');
    expect(summary?.textContent).toContain('Change "hello" to "HELLO"');
    const meta = panel.shadowRoot!.querySelector('.suggestion .comment-meta');
    expect(meta?.textContent).toContain('Alice');

    // The old side-by-side columns are no longer rendered in this panel.
    const diffCols = panel.shadowRoot!.querySelectorAll('.suggestion-diff .col');
    expect(diffCols.length).toBe(0);

    // Accept / Reject still fire.
    let acceptReceived: any = null;
    panel.addEventListener('comment-suggestion-accept', (e: any) => {
      acceptReceived = e.detail;
    });
    const acceptBtn = panel.shadowRoot!.querySelector(
      '.suggestion-actions .primary',
    ) as HTMLButtonElement;
    acceptBtn.click();
    expect(acceptReceived?.threadId).toBe('t1');
  });

  describe('orphaned suggestion (anchor lost after undo + GC)', () => {
    // A pending suggestion whose anchor's underlying Y.Text items have
    // been deleted (via accept-overwrite or undo+retype) and GC'd is
    // "orphaned": resolveAnchor returns null and the quoted_text fallback
    // can't find the original substring. Applying it would either no-op
    // or splat into the wrong location. The panel surfaces this case
    // explicitly: stale banner, Accept disabled, Reject swapped for
    // Dismiss (decideSuggestion('not_applicable')).

    function orphanedSuggestionThread() {
      return makeThread({
        suggestion: {
          human_readable: {
            summary: 'Change "1234" to "Hola!"',
            before_text: '1234',
            after_text: 'Hola!',
            operations: [],
          },
          author_id: 'u1',
          author_name: 'Alice',
          status: 'pending',
        } as any,
      });
    }

    function suggestionsCaps() {
      return {
        comment_edit: false,
        comment_delete: false,
        reactions: [],
        mentions: false,
        suggestions: true,
        max_comment_size: 10240,
        poll_supported: false,
      };
    }

    test('renders the stale banner when the orphaned flag is set', async () => {
      const panel = await mountPanel({
        thread: orphanedSuggestionThread(),
        orphaned: true,
      });
      const banner = panel.shadowRoot!.querySelector('.suggestion-orphan-banner');
      expect(banner, 'orphan banner should render').not.toBeNull();
      expect(banner!.textContent ?? '').toMatch(/no longer apply|original text/i);
    });

    test('Accept button is disabled when orphaned', async () => {
      const panel = await mountPanel({
        thread: orphanedSuggestionThread(),
        orphaned: true,
      });
      const accept = panel.shadowRoot!.querySelector(
        '.suggestion-actions .primary',
      ) as HTMLButtonElement | null;
      // Either the button is rendered as disabled, or it's omitted
      // entirely. Either is acceptable; the contract is "user cannot
      // click Accept on an orphaned suggestion."
      if (accept !== null) {
        expect(accept.disabled).toBe(true);
      }
    });

    test('Dismiss button fires comment-suggestion-dismiss with the threadId', async () => {
      const panel = await mountPanel({
        thread: orphanedSuggestionThread(),
        capabilities: suggestionsCaps(),
        orphaned: true,
      });
      let dismissed: any = null;
      panel.addEventListener('comment-suggestion-dismiss', (e: any) => {
        dismissed = e.detail;
      });
      const dismiss = panel.shadowRoot!.querySelector(
        '.suggestion-actions .dismiss',
      ) as HTMLButtonElement;
      expect(dismiss, 'Dismiss button should render in place of Reject').not.toBeNull();
      dismiss.click();
      expect(dismissed?.threadId).toBe('t1');
    });

    test('non-orphaned thread does not render the banner or Dismiss', async () => {
      const panel = await mountPanel({
        thread: orphanedSuggestionThread(),
        capabilities: suggestionsCaps(),
        // No `orphaned` prop set → defaults to false.
      });
      expect(panel.shadowRoot!.querySelector('.suggestion-orphan-banner')).toBeNull();
      expect(panel.shadowRoot!.querySelector('.suggestion-actions .dismiss')).toBeNull();
    });
  });

  test('@-mention autocomplete asks parent to resolve candidates', async () => {
    const panel = await mountPanel({ thread: makeThread() });
    panel.addEventListener('comment-mention-search', (e: any) => {
      e.detail.resolve([{ user_id: 'bob', display_name: 'Bob' }]);
    });

    const textarea = panel.shadowRoot!.querySelector('textarea')!;
    textarea.value = 'hey @bo';
    textarea.setSelectionRange(7, 7);
    textarea.dispatchEvent(new Event('input'));
    await (panel as any).updateComplete;

    const mentionItems = panel.shadowRoot!.querySelectorAll('.mention-item');
    expect(mentionItems.length).toBe(1);
    expect(mentionItems[0].textContent).toContain('Bob');
  });
});

describe('suggest-status', () => {
  async function mountStatus(overrides: Partial<SuggestStatus> = {}): Promise<SuggestStatus> {
    const el = document.createElement('suggest-status') as SuggestStatus;
    Object.assign(el, overrides);
    document.body.appendChild(el);
    await (el as any).updateComplete;
    return el;
  }

  test('Submit button disabled when no pending changes', async () => {
    const el = await mountStatus({ active: true, pendingChanges: 0 });
    const btn = el.shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test('Submit dispatches suggest-submit event', async () => {
    const el = await mountStatus({ active: true, pendingChanges: 2 });
    let fired = false;
    el.addEventListener('suggest-submit', () => { fired = true; });
    const btn = el.shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
    btn.click();
    expect(fired).toBe(true);
  });

  test('pluralizes pending change count', async () => {
    const single = await mountStatus({ active: true, pendingChanges: 1 });
    expect(single.shadowRoot!.querySelector('.count')!.textContent).toContain('1 pending change');
    const multi = await mountStatus({ active: true, pendingChanges: 3 });
    expect(multi.shadowRoot!.querySelector('.count')!.textContent).toContain('3 pending changes');
  });
});
