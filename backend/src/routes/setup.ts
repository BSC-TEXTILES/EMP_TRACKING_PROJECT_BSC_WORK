import { Router } from 'express';
import { needsSetup } from '../config.js';
import { asyncHandler, parseBody } from '../lib/http.js';
import { rateLimit } from '../middleware/security.js';
import { authorizeSetup, installWebsite, setupInput } from '../services/WebsiteSetupService.js';

export const setupRouter = Router();
setupRouter.get('/status', (_req, res) => { res.json({ required: needsSetup() }); });
setupRouter.post('/install', rateLimit({ windowMs: 15 * 60000, max: 10, keyPrefix: 'setup' }), asyncHandler(async (req, res) => {
  authorizeSetup(req.get('X-Setup-Code'));
  const input = parseBody(setupInput, req.body);
  await installWebsite(input);
  res.status(201).json({ installed: true });
}));
