/**
 * HTTP handler factory for Express.
 *
 * Two integration modes:
 * 1. createExpressRouter(provider) — returns an Express Router, mount on your app
 * 2. Use ProviderProcessor directly — call processLoad/processStore from your own controller
 */
import type { Router, Request, Response } from 'express';
import type { Provider } from './provider.js';
import { ProviderProcessor } from './provider.js';

/**
 * Create an Express Router with the standard SPI endpoints.
 *
 * Usage:
 * ```ts
 * import express from 'express';
 * import { createExpressRouter } from '@imyousuf/collab-editor-provider';
 *
 * const app = express();
 * app.use('/collab', createExpressRouter(myProvider));
 * ```
 */
export function createExpressRouter(
  provider: Provider,
  opts?: { cacheSize?: number },
): Router {
  // Dynamic import to avoid requiring express as a hard dependency
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  const router: Router = express.Router();
  const processor = new ProviderProcessor(provider, opts);

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const resp = await processor.processHealth();
      res.json(resp);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/documents/load', async (req: Request, res: Response) => {
    const documentId = req.query.path as string;
    if (!documentId) {
      res.status(400).json({ error: "missing 'path' query parameter" });
      return;
    }
    try {
      const resp = await processor.processLoad(documentId);
      res.json(resp);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/documents/updates', express.json(), async (req: Request, res: Response) => {
    const documentId = req.query.path as string;
    if (!documentId) {
      res.status(400).json({ error: "missing 'path' query parameter" });
      return;
    }
    try {
      const resp = await processor.processStore(documentId, req.body.updates ?? []);
      const status = resp.failed && resp.failed.length > 0 ? 207 : 202;
      res.status(status).json(resp);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/documents', async (_req: Request, res: Response) => {
    try {
      const docs = await processor.processList();
      res.json({ documents: docs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Optional: VERSIONS
  if (provider.listVersions) {
    router.get('/documents/versions', async (req: Request, res: Response) => {
      const documentId = req.query.path as string;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      try {
        const versions = await processor.processListVersions(documentId);
        res.json({ versions });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/documents/versions', express.json(), async (req: Request, res: Response) => {
      const documentId = req.query.path as string;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      try {
        const entry = await processor.processCreateVersion(documentId, req.body);
        if (!entry) {
          res.status(500).json({ error: 'version creation not supported' });
          return;
        }
        res.status(201).json(entry);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get('/documents/versions/detail', async (req: Request, res: Response) => {
      const documentId = req.query.path as string;
      const versionId = req.query.version as string;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      if (!versionId) {
        res.status(400).json({ error: "missing 'version' query parameter" });
        return;
      }
      try {
        const entry = await processor.processGetVersion(documentId, versionId);
        if (!entry) {
          res.status(404).json({ error: 'version not found' });
          return;
        }
        res.json(entry);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  // Optional: CLIENT MAPPINGS
  if (provider.getClientMappings) {
    router.get('/documents/clients', async (req: Request, res: Response) => {
      const documentId = req.query.path as string;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      try {
        const mappings = await processor.processGetClientMappings(documentId);
        res.json({ mappings });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/documents/clients', express.json(), async (req: Request, res: Response) => {
      const documentId = req.query.path as string;
      if (!documentId) {
        res.status(400).json({ error: "missing 'path' query parameter" });
        return;
      }
      try {
        await processor.processStoreClientMappings(documentId, req.body.mappings ?? []);
        res.json({ stored: (req.body.mappings ?? []).length });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  return router;
}

/**
 * Create a standalone HTTP server with the SPI endpoints.
 *
 * Usage:
 * ```ts
 * import { serve } from '@imyousuf/collab-editor-provider';
 * serve(myProvider, { port: 8081 });
 * ```
 */
export function serve(
  provider: Provider,
  opts?: { port?: number; cacheSize?: number },
): void {
  const express = require('express');
  const app = express();
  const port = opts?.port ?? 8081;

  app.use('/', createExpressRouter(provider, opts));

  app.listen(port, () => {
    console.log(`Provider SDK server listening on :${port}`);
  });
}
