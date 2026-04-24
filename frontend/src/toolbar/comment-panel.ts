/**
 * Comment panel — popover anchored to the active comment anchor.
 *
 * Responsibilities:
 *   - Render the thread (comments + suggestion, if any).
 *   - Markdown-render comment bodies and the suggestion summary.
 *   - Reply textarea with @-mention autocomplete.
 *   - Resolve / reopen + delete (capability-gated).
 *   - Suggestion Accept / Reject (capability-gated).
 *
 * Events dispatched on the parent:
 *   - comment-panel-close
 *   - comment-reply         { threadId, content }
 *   - comment-thread-resolve { threadId }
 *   - comment-thread-reopen  { threadId }
 *   - comment-thread-delete  { threadId }
 *   - comment-reaction-add   { threadId, commentId|null, emoji }
 *   - comment-reaction-remove { threadId, commentId|null, emoji }
 *   - comment-suggestion-accept { threadId }
 *   - comment-suggestion-reject { threadId }
 *   - comment-mention-search { query, resolve }   (async — multi-editor calls resolve([...]))
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  Comment,
  CommentThread,
  CommentsCapabilities,
  MentionCandidate,
} from '../interfaces/comments.js';

@customElement('comment-panel')
export class CommentPanel extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ attribute: false }) thread: CommentThread | null = null;
  @property({ attribute: false }) capabilities: CommentsCapabilities | null = null;
  @property({ attribute: false }) currentUserId = '';
  /**
   * Draft anchor. When set and `thread` is null, the panel renders a
   * draft-thread form: just the quoted text + textarea + Send. Submitting
   * creates the thread with the typed content as the first comment;
   * closing discards the draft without creating anything.
   */
  @property({ attribute: false }) draftAnchor: { quoted_text: string } | null = null;

  @state() private _replyDraft = '';
  @state() private _mentionOptions: MentionCandidate[] = [];
  @state() private _mentionActive = false;

  static override styles = css`
    :host {
      display: none;
      position: absolute;
      z-index: 1000;
      width: 360px;
      max-width: 90vw;
    }
    :host([open]) { display: block; }
    .panel {
      background: var(--me-bg, #fff);
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      overflow: hidden;
      font-size: 13px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--me-toolbar-border, #eee);
      gap: 8px;
    }
    .header-quote {
      flex: 1;
      font-style: italic;
      color: var(--me-status-color, #444);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions button {
      background: none;
      border: 1px solid transparent;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .actions button:hover { background: var(--me-toolbar-button-hover-bg, #f0f0f0); }
    .actions .primary {
      border-color: var(--me-toolbar-border, #d0d7de);
      background: var(--me-toolbar-button-hover-bg, #f8f9fa);
    }

    .suggestion {
      padding: 10px 14px;
      background: rgba(66, 135, 245, 0.05);
      border-bottom: 1px solid var(--me-toolbar-border, #eee);
    }
    .suggestion-summary {
      font-weight: 600;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .suggestion-summary .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      text-transform: uppercase;
      background: var(--me-suggest-badge-bg, #e3f2fd);
      color: var(--me-suggest-badge-color, #1565c0);
    }
    .suggestion-diff {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 6px 0 10px;
    }
    .suggestion-diff .col {
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--me-suggest-col-bg, rgba(0, 0, 0, 0.03));
      word-break: break-word;
    }
    .suggestion-diff .col.before {
      color: var(--me-suggest-before-color, #b71c1c);
      text-decoration: line-through;
    }
    .suggestion-diff .col.after {
      color: var(--me-suggest-after-color, #1b5e20);
      text-decoration: underline;
    }
    .suggestion-actions { display: flex; gap: 6px; }

    .comments {
      max-height: 300px;
      overflow-y: auto;
    }
    .comment {
      padding: 10px 14px;
      border-bottom: 1px solid var(--me-toolbar-border, #f0f0f0);
    }
    .comment:last-child { border-bottom: none; }
    .comment-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 4px;
    }
    .comment-author { font-weight: 600; color: var(--me-status-color, #333); }
    .comment-meta { font-size: 11px; color: var(--me-comment-meta-color, #888); }
    .comment-body { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
    .comment-body.deleted { color: var(--me-comment-deleted-color, #aaa); font-style: italic; }

    .reply {
      padding: 10px 14px;
      border-top: 1px solid var(--me-toolbar-border, #eee);
      position: relative;
    }
    .reply textarea {
      width: 100%;
      min-height: 52px;
      resize: vertical;
      padding: 6px 8px;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
      box-sizing: border-box;
    }
    .reply-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 6px;
    }
    .mention-list {
      position: absolute;
      bottom: 72px;
      left: 14px;
      right: 14px;
      background: var(--me-bg, #fff);
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      max-height: 140px;
      overflow-y: auto;
      font-size: 12px;
    }
    .mention-item {
      padding: 6px 8px;
      cursor: pointer;
    }
    .mention-item:hover { background: var(--me-toolbar-button-hover-bg, #f0f0f0); }

    .resolved-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      border-top: 1px solid var(--me-toolbar-border, #eee);
      font-size: 11px;
      color: var(--me-comment-meta-color, #888);
      gap: 8px;
    }
    .resolved-note { font-style: italic; }
    .reopen-link {
      background: none;
      border: none;
      padding: 2px 4px;
      cursor: pointer;
      font-size: 11px;
      color: var(--me-wysiwyg-link-color, #2563eb);
      text-decoration: underline;
    }
    .reopen-link:hover { color: var(--me-version-btn-primary-hover-bg, #1d4ed8); }
  `;

  override render(): TemplateResult | typeof nothing {
    if (!this.thread && this.draftAnchor) return this._renderDraft(this.draftAnchor);
    if (!this.thread) return nothing;
    const t = this.thread;
    const isResolved = t.status === 'resolved';
    const canDelete = this.capabilities?.comment_delete ?? false;
    return html`
      <div class="panel">
        <div class="header">
          <span class="header-quote" title="${t.anchor.quoted_text}">
            ${quoteLabel(t)}
          </span>
          <div class="actions">
            ${isResolved
              ? nothing
              : html`<button class="primary" @click=${() => this._dispatch('comment-thread-resolve', { threadId: t.id })}>Resolve</button>`}
            ${canDelete
              ? html`<button title="Delete thread" @click=${() => this._dispatch('comment-thread-delete', { threadId: t.id })}>🗑</button>`
              : nothing}
            <button title="Close" @click=${() => this._dispatch('comment-panel-close', {})}>×</button>
          </div>
        </div>

        ${t.suggestion ? this._renderSuggestion(t.suggestion) : nothing}

        <div class="comments">
          ${t.comments.length === 0 && !t.suggestion
            ? html`<div class="comment"><em>No comments yet.</em></div>`
            : t.comments.map((c) => this._renderComment(c))}
        </div>

        ${isResolved ? this._renderResolvedFooter(t) : this._renderReplyBox(t.id)}
      </div>
    `;
  }

  /**
   * Resolved threads are opened from the status-bar history list and are
   * meant for reading, not editing. We intentionally do NOT put "Reopen"
   * next to the Close × — users would misclick it thinking it activates
   * the thread, which brings back the inline highlight and confuses the
   * mental model. Reopen lives as a deliberate link in the footer with
   * a confirmation prompt.
   */
  private _renderResolvedFooter(t: CommentThread): TemplateResult {
    const resolvedBy = t.resolved_by ?? 'someone';
    const resolvedAt = t.resolved_at ? formatRelative(t.resolved_at) : '';
    return html`
      <div class="resolved-footer">
        <span class="resolved-note">
          Resolved by ${resolvedBy}${resolvedAt ? ` · ${resolvedAt}` : ''}
        </span>
        <button class="reopen-link" @click=${() => this._confirmReopen(t.id)}>Reopen thread</button>
      </div>
    `;
  }

  private _confirmReopen(threadId: string): void {
    const ok =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
            'Reopen this thread? The inline highlight will reappear on the anchored text.',
          )
        : true;
    if (!ok) return;
    this._dispatch('comment-thread-reopen', { threadId });
  }

  private _renderSuggestion(s: NonNullable<CommentThread['suggestion']>): TemplateResult {
    const canDecide = this.capabilities?.suggestions ?? false;
    const decidedLabel =
      s.status === 'accepted' || s.status === 'rejected'
        ? `${s.status} by ${s.decided_by_name ?? s.decided_by ?? 'unknown'}`
        : null;
    // Diff body is rendered elsewhere (multi-editor's full-width
    // suggestion-diff-bar) to avoid cramming a diff into this 360px
    // popover. Here we show just the summary + metadata + actions.
    return html`
      <div class="suggestion">
        <div class="suggestion-summary">
          <span>🔸 ${s.human_readable.summary}</span>
          <span class="badge">${s.status}</span>
        </div>
        <div class="comment-meta" style="margin-bottom: 6px;">
          suggested by ${s.author_name || s.author_id || 'unknown'}
          ${decidedLabel ? html` · ${decidedLabel}` : nothing}
        </div>
        ${s.status === 'pending' && canDecide
          ? html`
              <div class="suggestion-actions">
                <button class="primary" @click=${() => this._dispatch('comment-suggestion-accept', { threadId: this.thread?.id })}>Accept</button>
                <button @click=${() => this._dispatch('comment-suggestion-reject', { threadId: this.thread?.id })}>Reject</button>
              </div>
            `
          : nothing}
        ${s.author_note
          ? html`<div class="comment-body" style="margin-top: 6px; font-size: 12px;">${s.author_note}</div>`
          : nothing}
      </div>
    `;
  }

  private _renderComment(c: Comment): TemplateResult {
    const isDeleted = !!c.deleted_at;
    const edited = !!c.updated_at && !isDeleted;
    return html`
      <div class="comment" data-comment-id=${c.id}>
        <div class="comment-head">
          <span class="comment-author">${c.author_name}</span>
          <span class="comment-meta">
            ${formatRelative(c.created_at)}${edited ? ' · edited' : ''}
          </span>
        </div>
        <div class="comment-body ${isDeleted ? 'deleted' : ''}">
          ${isDeleted ? '(deleted)' : renderCommentContent(c.content)}
        </div>
      </div>
    `;
  }

  private _renderDraft(anchor: { quoted_text: string }): TemplateResult {
    const cancel = () => this._dispatch('comment-draft-cancel', {});
    return html`
      <div class="panel">
        <div class="header">
          <span class="header-quote" title="${anchor.quoted_text}">
            "${anchor.quoted_text || '(empty)'}"
          </span>
          <div class="actions">
            <button title="Cancel" @click=${cancel}>×</button>
          </div>
        </div>
        ${this._renderComposer({
          placeholder: 'Add a comment… (type @ for mentions)',
          secondaryLabel: 'Cancel',
          onSecondary: cancel,
          onSend: () => this._submitDraft(),
          autofocus: true,
        })}
      </div>
    `;
  }

  private _submitDraft(): void {
    const content = this._replyDraft.trim();
    if (!content) return;
    this._dispatch('comment-draft-submit', { content });
    this._replyDraft = '';
    this._mentionActive = false;
  }

  private _renderReplyBox(threadId: string): TemplateResult {
    return this._renderComposer({
      placeholder: 'Reply… (type @ for mentions)',
      secondaryLabel: 'Clear',
      onSecondary: () => {
        this._replyDraft = '';
        this._mentionActive = false;
      },
      onSend: () => this._sendReply(threadId),
      autofocus: false,
    });
  }

  /**
   * Shared textarea + mention-list + action buttons. Used by both the
   * reply box on an existing thread and the draft composer on a new
   * thread — the only difference is the secondary button (Clear vs
   * Cancel), the placeholder, and what onSend does.
   */
  private _renderComposer(opts: {
    placeholder: string;
    secondaryLabel: string;
    onSecondary: () => void;
    onSend: () => void;
    autofocus: boolean;
  }): TemplateResult {
    return html`
      <div class="reply">
        ${this._mentionActive && this._mentionOptions.length > 0
          ? html`
              <div class="mention-list">
                ${this._mentionOptions.map(
                  (m) => html`
                    <div class="mention-item" @click=${() => this._insertMention(m)}>
                      @${m.display_name}
                      <span class="comment-meta">${m.user_id}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
        <textarea
          .value=${this._replyDraft}
          @input=${(e: Event) => this._onReplyInput(e)}
          placeholder="${opts.placeholder}"
          ?autofocus=${opts.autofocus}
        ></textarea>
        <div class="reply-actions">
          <button @click=${opts.onSecondary}>${opts.secondaryLabel}</button>
          <button
            class="primary"
            ?disabled=${this._replyDraft.trim().length === 0}
            @click=${opts.onSend}
          >Send</button>
        </div>
      </div>
    `;
  }

  private _onReplyInput(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this._replyDraft = textarea.value;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const preCaret = textarea.value.slice(0, caret);
    const match = preCaret.match(/@([\w-]*)$/);
    if (match) {
      this._mentionActive = true;
      this._requestMentionOptions(match[1]);
    } else {
      this._mentionActive = false;
      this._mentionOptions = [];
    }
  }

  private _requestMentionOptions(query: string): void {
    // Multi-editor resolves via engine.searchMentions(); we don't fetch
    // directly because that would couple the UI to network details.
    const event = new CustomEvent('comment-mention-search', {
      bubbles: true,
      composed: true,
      detail: {
        query,
        resolve: (results: MentionCandidate[]) => {
          this._mentionOptions = results;
        },
      },
    });
    this.dispatchEvent(event);
  }

  private _insertMention(m: MentionCandidate): void {
    this._replyDraft = this._replyDraft.replace(
      /@([\w-]*)$/,
      `@[${m.display_name}](${m.user_id}) `,
    );
    this._mentionActive = false;
    this._mentionOptions = [];
  }

  private _sendReply(threadId: string): void {
    const content = this._replyDraft.trim();
    if (!content) return;
    this._dispatch('comment-reply', { threadId, content });
    this._replyDraft = '';
    this._mentionActive = false;
  }

  private _dispatch(name: string, detail: any): void {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }
}

// --- Helpers ---

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

/**
 * Render comment content with mention tokens stylized. Keeps markdown-ish
 * styling minimal to stay lightweight; the full markdown pipeline runs
 * elsewhere when comments are piped through it.
 */
/**
 * Best-effort label for the thread's anchor header. Falls back in this order:
 *   1. The quoted source text (present for range comments).
 *   2. For insert-only suggestions: the proposed inserted text, prefixed
 *      with a "+" so the user can see what's being added.
 *   3. The literal "(orphaned)" when nothing is recoverable.
 *
 * Exported for unit tests; the comment-list-panel has an identical copy.
 */
export function quoteLabel(t: CommentThread): string {
  if (t.anchor.quoted_text) return `"${t.anchor.quoted_text}"`;
  const s = t.suggestion;
  if (s && s.human_readable) {
    const after = (s.human_readable.after_text ?? '').trim();
    if (after) {
      const snippet = after.length > 48 ? after.slice(0, 47) + '…' : after;
      return `+ "${snippet}"`;
    }
  }
  return '(orphaned)';
}

function renderCommentContent(content: string): TemplateResult {
  const pieces: (string | TemplateResult)[] = [];
  const re = /@\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      pieces.push(content.slice(lastIndex, match.index));
    }
    pieces.push(
      html`<span
        style="background: var(--me-suggest-badge-bg, #e3f2fd); color: var(--me-suggest-badge-color, #1565c0); padding: 0 4px; border-radius: 3px;"
        data-mention-user-id=${match[2]}
      >@${match[1]}</span>`,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) pieces.push(content.slice(lastIndex));
  return html`${pieces}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'comment-panel': CommentPanel;
  }
}
