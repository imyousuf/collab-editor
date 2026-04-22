/**
 * Express router factory for a CommentsProvider.
 *
 * Plain REST + JSON — no Yjs engine involved. Conditional routes are
 * registered based on optional method presence on the provider.
 */
import type { Router, Request, Response } from 'express';
import type { CommentsProvider } from './provider.js';

export function createCommentsExpressRouter(provider: CommentsProvider): Router {
  // Defer express to keep it as an optional peer dependency.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  const router: Router = express.Router();
  const json = express.json({ limit: '256kb' });

  router.get('/capabilities', async (_req: Request, res: Response) => {
    try {
      const caps = await provider.capabilities();
      res.json(caps);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/documents/comments', async (req: Request, res: Response) => {
    const documentId = req.query.path as string | undefined;
    if (!documentId) {
      res.status(400).json({ error: "missing 'path' query parameter" });
      return;
    }
    try {
      const threads = await provider.listCommentThreads(documentId);
      res.json({ threads });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/documents/comments', json, async (req: Request, res: Response) => {
    const documentId = req.query.path as string | undefined;
    if (!documentId) {
      res.status(400).json({ error: "missing 'path' query parameter" });
      return;
    }
    try {
      const thread = await provider.createCommentThread(documentId, req.body);
      res.status(201).json(thread);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Optional: mentions search (mounted before :threadId routes to avoid shadowing).
  if (provider.searchMentions) {
    router.get('/documents/comments/mentions/search', async (req: Request, res: Response) => {
      const documentId = req.query.path as string | undefined;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      const query = (req.query.q as string) ?? '';
      const limit = Number.parseInt((req.query.limit as string) ?? '10', 10) || 10;
      try {
        const candidates = await provider.searchMentions!(documentId, query, limit);
        res.json({ candidates });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  // Optional: external-change polling (mounted before :threadId routes).
  if (provider.pollCommentChanges) {
    router.get('/documents/comments/poll', async (req: Request, res: Response) => {
      const documentId = req.query.path as string | undefined;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      const since = (req.query.since as string) ?? '';
      try {
        const resp = await provider.pollCommentChanges!(documentId, since);
        res.json(resp);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  router.get('/documents/comments/:threadId', async (req: Request, res: Response) => {
    const documentId = req.query.path as string | undefined;
    if (!documentId) {
      res.status(400).json({ error: "missing 'path' query parameter" });
      return;
    }
    try {
      const thread = await provider.getCommentThread(documentId, String(req.params.threadId));
      if (!thread) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      res.json(thread);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post(
    '/documents/comments/:threadId/replies',
    json,
    async (req: Request, res: Response) => {
      const documentId = req.query.path as string | undefined;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      try {
        const comment = await provider.addReply(documentId, String(req.params.threadId), req.body);
        res.status(201).json(comment);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.patch(
    '/documents/comments/:threadId',
    json,
    async (req: Request, res: Response) => {
      const documentId = req.query.path as string | undefined;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      try {
        const thread = await provider.updateThreadStatus(
          documentId,
          String(req.params.threadId),
          req.body,
        );
        res.json(thread);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  router.delete('/documents/comments/:threadId', async (req: Request, res: Response) => {
    const documentId = req.query.path as string | undefined;
    if (!documentId) {
      res.status(400).json({ error: "missing 'path' query parameter" });
      return;
    }
    try {
      await provider.deleteCommentThread(documentId, String(req.params.threadId));
      res.status(204).end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  if (provider.updateComment) {
    router.patch(
      '/documents/comments/:threadId/comments/:commentId',
      json,
      async (req: Request, res: Response) => {
        const documentId = req.query.path as string | undefined;
        if (!documentId) {
          res.status(400).json({ error: "missing 'path' query parameter" });
          return;
        }
        try {
          const comment = await provider.updateComment!(
            documentId,
            String(req.params.threadId),
            String(req.params.commentId),
            req.body,
          );
          res.json(comment);
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );
  }

  if (provider.deleteComment) {
    router.delete(
      '/documents/comments/:threadId/comments/:commentId',
      async (req: Request, res: Response) => {
        const documentId = req.query.path as string | undefined;
        if (!documentId) {
          res.status(400).json({ error: "missing 'path' query parameter" });
          return;
        }
        try {
          await provider.deleteComment!(documentId, String(req.params.threadId), String(req.params.commentId));
          res.status(204).end();
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );
  }

  if (provider.addReaction) {
    router.post(
      '/documents/comments/:threadId/reactions',
      json,
      async (req: Request, res: Response) => {
        const documentId = req.query.path as string | undefined;
        if (!documentId) {
          res.status(400).json({ error: "missing 'path' query parameter" });
          return;
        }
        try {
          await provider.addReaction!(documentId, String(req.params.threadId), req.body);
          res.status(204).end();
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );
  }

  if (provider.removeReaction) {
    router.delete(
      '/documents/comments/:threadId/reactions',
      json,
      async (req: Request, res: Response) => {
        const documentId = req.query.path as string | undefined;
        if (!documentId) {
          res.status(400).json({ error: "missing 'path' query parameter" });
          return;
        }
        try {
          await provider.removeReaction!(documentId, String(req.params.threadId), req.body);
          res.status(204).end();
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );
  }

  if (provider.decideSuggestion) {
    router.post(
      '/documents/comments/:threadId/suggestion/decision',
      json,
      async (req: Request, res: Response) => {
        const documentId = req.query.path as string | undefined;
        if (!documentId) {
          res.status(400).json({ error: "missing 'path' query parameter" });
          return;
        }
        try {
          const thread = await provider.decideSuggestion!(
            documentId,
            String(req.params.threadId),
            req.body,
          );
          res.json(thread);
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );
  }

  return router;
}
