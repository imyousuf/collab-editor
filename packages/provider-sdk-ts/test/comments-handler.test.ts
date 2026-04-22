import { describe, test, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCommentsExpressRouter } from '../src/comments/handler.js';
import type {
  CommentsProvider,
  CommentThread,
  CommentsCapabilities,
  CommentThreadListEntry,
  Comment,
  MentionCandidate,
  CommentPollResponse,
} from '../src/comments/index.js';

function makeApp(provider: CommentsProvider) {
  const app = express();
  app.use('/', createCommentsExpressRouter(provider));
  return app;
}

function coreProvider(overrides: Partial<CommentsProvider> = {}): CommentsProvider {
  const threads = new Map<string, CommentThread>();
  const base: CommentsProvider = {
    async capabilities(): Promise<CommentsCapabilities> {
      return {
        comment_edit: false,
        comment_delete: false,
        reactions: [],
        mentions: false,
        suggestions: false,
        max_comment_size: 10240,
        poll_supported: false,
      };
    },
    async listCommentThreads(_documentId: string): Promise<CommentThreadListEntry[]> {
      return [...threads.values()].map((t) => ({
        id: t.id,
        anchor: t.anchor,
        status: t.status,
        created_at: t.created_at,
        comment_count: t.comments.length,
        has_suggestion: !!t.suggestion,
        suggestion_status: t.suggestion?.status,
      }));
    },
    async getCommentThread(_doc, threadId) {
      return threads.get(threadId) ?? null;
    },
    async createCommentThread(_doc, req) {
      const t: CommentThread = {
        id: `t-${threads.size + 1}`,
        document_id: _doc,
        anchor: req.anchor,
        status: 'open',
        created_at: new Date().toISOString(),
        comments: req.comment
          ? [
              {
                id: 'c-1',
                thread_id: `t-${threads.size + 1}`,
                author_id: req.comment.author_id,
                author_name: req.comment.author_name,
                content: req.comment.content,
                mentions: req.comment.mentions,
                created_at: new Date().toISOString(),
              },
            ]
          : [],
        suggestion: req.suggestion,
      };
      threads.set(t.id, t);
      return t;
    },
    async addReply(_doc, threadId, req) {
      const c: Comment = {
        id: `c-${Date.now()}`,
        thread_id: threadId,
        author_id: req.author_id,
        author_name: req.author_name,
        content: req.content,
        mentions: req.mentions,
        created_at: new Date().toISOString(),
      };
      const t = threads.get(threadId);
      if (t) t.comments.push(c);
      return c;
    },
    async updateThreadStatus(_doc, threadId, req) {
      const t = threads.get(threadId);
      if (!t) throw new Error('not found');
      t.status = req.status;
      if (req.status === 'resolved') {
        t.resolved_at = new Date().toISOString();
        t.resolved_by = req.resolved_by;
      }
      return t;
    },
    async deleteCommentThread(_doc, threadId) {
      threads.delete(threadId);
    },
  };
  return { ...base, ...overrides };
}

describe('createCommentsExpressRouter — core routes', () => {
  let provider: CommentsProvider;

  beforeEach(() => {
    provider = coreProvider();
  });

  test('GET /capabilities returns provider capabilities', async () => {
    const app = makeApp(provider);
    const res = await request(app).get('/capabilities');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      comment_edit: false,
      reactions: [],
      mentions: false,
      suggestions: false,
      max_comment_size: 10240,
    });
  });

  test('POST /documents/comments requires path', async () => {
    const app = makeApp(provider);
    const res = await request(app).post('/documents/comments').send({});
    expect(res.status).toBe(400);
  });

  test('POST /documents/comments creates thread with 201', async () => {
    const app = makeApp(provider);
    const res = await request(app)
      .post('/documents/comments?path=doc.md')
      .send({
        anchor: { start: 0, end: 5, quoted_text: 'hello' },
        comment: {
          author_id: 'u1',
          author_name: 'Alice',
          content: 'What do you think?',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.comments).toHaveLength(1);
  });

  test('GET /documents/comments/:id returns 404 when missing', async () => {
    const app = makeApp(provider);
    const res = await request(app).get('/documents/comments/missing?path=doc.md');
    expect(res.status).toBe(404);
  });

  test('PATCH /documents/comments/:id resolves thread', async () => {
    const app = makeApp(provider);
    const create = await request(app)
      .post('/documents/comments?path=doc.md')
      .send({
        anchor: { start: 0, end: 1, quoted_text: 'a' },
        comment: { author_id: 'u1', author_name: 'Alice', content: 'hi' },
      });
    const threadId = create.body.id;

    const patch = await request(app)
      .patch(`/documents/comments/${threadId}?path=doc.md`)
      .send({ status: 'resolved', resolved_by: 'u1' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('resolved');
    expect(patch.body.resolved_by).toBe('u1');
  });

  test('DELETE /documents/comments/:id returns 204', async () => {
    const app = makeApp(provider);
    const create = await request(app)
      .post('/documents/comments?path=doc.md')
      .send({ anchor: { start: 0, end: 1, quoted_text: 'a' } });
    const res = await request(app).delete(`/documents/comments/${create.body.id}?path=doc.md`);
    expect(res.status).toBe(204);
  });

  test('POST replies returns 201', async () => {
    const app = makeApp(provider);
    const create = await request(app)
      .post('/documents/comments?path=doc.md')
      .send({
        anchor: { start: 0, end: 1, quoted_text: 'a' },
        comment: { author_id: 'u1', author_name: 'Alice', content: 'first' },
      });
    const res = await request(app)
      .post(`/documents/comments/${create.body.id}/replies?path=doc.md`)
      .send({ author_id: 'u2', author_name: 'Bob', content: 'reply' });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('reply');
  });
});

describe('createCommentsExpressRouter — optional route gating', () => {
  test('reactions/suggestions/mentions/poll/comment-edit routes return 404 when not implemented', async () => {
    const app = makeApp(coreProvider());

    const paths: Array<[string, string]> = [
      ['POST', '/documents/comments/t1/reactions?path=doc.md'],
      ['DELETE', '/documents/comments/t1/reactions?path=doc.md'],
      ['POST', '/documents/comments/t1/suggestion/decision?path=doc.md'],
      ['GET', '/documents/comments/mentions/search?path=doc.md&q=a'],
      ['GET', '/documents/comments/poll?path=doc.md&since=2020-01-01'],
      ['PATCH', '/documents/comments/t1/comments/c1?path=doc.md'],
      ['DELETE', '/documents/comments/t1/comments/c1?path=doc.md'],
    ];
    for (const [method, url] of paths) {
      // eslint-disable-next-line no-await-in-loop
      const res = await (request(app) as any)[method.toLowerCase()](url).send({});
      expect([404, 405]).toContain(res.status);
    }
  });

  test('optional routes are registered when provider implements them', async () => {
    const log: string[] = [];
    const provider: CommentsProvider = {
      ...coreProvider(),
      async updateComment() {
        log.push('updateComment');
        return {
          id: 'c1',
          thread_id: 't1',
          author_id: 'u1',
          author_name: 'Alice',
          content: 'edited',
          created_at: new Date().toISOString(),
        };
      },
      async deleteComment() {
        log.push('deleteComment');
      },
      async addReaction() {
        log.push('addReaction');
      },
      async removeReaction() {
        log.push('removeReaction');
      },
      async decideSuggestion() {
        log.push('decideSuggestion');
        return {
          id: 't1',
          document_id: 'doc.md',
          anchor: { start: 0, end: 1, quoted_text: 'a' },
          status: 'resolved',
          created_at: new Date().toISOString(),
          comments: [],
        };
      },
      async searchMentions(): Promise<MentionCandidate[]> {
        log.push('searchMentions');
        return [{ user_id: 'u1', display_name: 'Alice' }];
      },
      async pollCommentChanges(): Promise<CommentPollResponse> {
        log.push('pollCommentChanges');
        return {
          changes: [{ thread_id: 't1', action: 'resolved', by: 'u1', at: new Date().toISOString() }],
          server_time: new Date().toISOString(),
        };
      },
    };
    const app = makeApp(provider);

    let res = await request(app)
      .patch('/documents/comments/t1/comments/c1?path=doc.md')
      .send({ content: 'edited' });
    expect(res.status).toBe(200);

    res = await request(app).delete('/documents/comments/t1/comments/c1?path=doc.md');
    expect(res.status).toBe(204);

    res = await request(app)
      .post('/documents/comments/t1/reactions?path=doc.md')
      .send({ user_id: 'u1', user_name: 'Alice', emoji: 'thumbsup' });
    expect(res.status).toBe(204);

    res = await request(app)
      .delete('/documents/comments/t1/reactions?path=doc.md')
      .send({ user_id: 'u1', user_name: 'Alice', emoji: 'thumbsup' });
    expect(res.status).toBe(204);

    res = await request(app)
      .post('/documents/comments/t1/suggestion/decision?path=doc.md')
      .send({ decision: 'accepted', decided_by: 'u1' });
    expect(res.status).toBe(200);

    res = await request(app).get('/documents/comments/mentions/search?path=doc.md&q=ali&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].user_id).toBe('u1');

    res = await request(app).get('/documents/comments/poll?path=doc.md&since=2020-01-01');
    expect(res.status).toBe(200);
    expect(res.body.changes[0].thread_id).toBe('t1');

    expect(log).toEqual([
      'updateComment',
      'deleteComment',
      'addReaction',
      'removeReaction',
      'decideSuggestion',
      'searchMentions',
      'pollCommentChanges',
    ]);
  });
});

describe('yjs_payload remains opaque through the handler', () => {
  test('payload bytes are not mutated on create or retrieve', async () => {
    const wantPayload = 'AQECAwQFBgcI';
    let captured: string | undefined;
    const provider: CommentsProvider = {
      ...coreProvider(),
      async createCommentThread(_doc, req) {
        captured = req.suggestion?.yjs_payload;
        return {
          id: 't1',
          document_id: _doc,
          anchor: req.anchor,
          status: 'open',
          created_at: new Date().toISOString(),
          comments: [],
          suggestion: req.suggestion,
        };
      },
      async getCommentThread(_doc, threadId) {
        if (threadId !== 't1') return null;
        return {
          id: 't1',
          document_id: 'doc.md',
          anchor: { start: 0, end: 1, quoted_text: 'a' },
          status: 'open',
          created_at: new Date().toISOString(),
          comments: [],
          suggestion: {
            yjs_payload: wantPayload,
            human_readable: {
              summary: 's',
              before_text: 'a',
              after_text: 'A',
              operations: [],
            },
            author_id: 'u1',
            author_name: 'Alice',
            status: 'pending',
          },
        };
      },
    };
    const app = makeApp(provider);

    const create = await request(app)
      .post('/documents/comments?path=doc.md')
      .send({
        anchor: { start: 0, end: 1, quoted_text: 'a' },
        suggestion: {
          yjs_payload: wantPayload,
          human_readable: {
            summary: 'x',
            before_text: 'a',
            after_text: 'A',
            operations: [],
          },
          author_id: 'u1',
          author_name: 'Alice',
          status: 'pending',
        },
      });
    expect(create.status).toBe(201);
    expect(captured).toBe(wantPayload);
    expect(create.body.suggestion.yjs_payload).toBe(wantPayload);

    const get = await request(app).get('/documents/comments/t1?path=doc.md');
    expect(get.status).toBe(200);
    expect(get.body.suggestion.yjs_payload).toBe(wantPayload);
  });
});
