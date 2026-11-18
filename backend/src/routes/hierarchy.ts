import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requireAny, type AuthedRequest } from '../middleware/auth.js';
import { HierarchyService } from '../services/HierarchyService.js';

/**
 * Reporting hierarchy, live workforce tracking and location analytics.
 * Every handler resolves the viewer's scope server-side (HierarchyService.scope),
 * so changing a URL or an id never widens what a user can see.
 */
export const hierarchyRouter = Router();
hierarchyRouter.use(authenticate);

hierarchyRouter.get(
  '/overview',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await HierarchyService.overview(currentUser(req), req.query.locationId));
  }),
);

hierarchyRouter.get(
  '/employees/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await HierarchyService.employeeDetail(currentUser(req), intParam(req.params.id as string)));
  }),
);

hierarchyRouter.get(
  '/analytics',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      await HierarchyService.analytics(currentUser(req), {
        from: typeof req.query.from === 'string' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' ? req.query.to : undefined,
        locationId: req.query.locationId,
      }),
    );
  }),
);

hierarchyRouter.put(
  '/employees/:id/assignment',
  requireAny('hierarchy.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(
      z.object({
        managerId: z.number().int().positive().nullable().optional(),
        locationId: z.number().int().positive().optional(),
        reason: z.string().max(160).optional(),
      }),
      req.body,
    );
    res.json(await HierarchyService.assign(currentUser(req), intParam(req.params.id as string), body, clientIp(req)));
  }),
);

hierarchyRouter.get(
  '/locations/:id/managers',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ managers: await HierarchyService.locationManagers(currentUser(req), intParam(req.params.id as string)) });
  }),
);

hierarchyRouter.put(
  '/locations/:id/managers',
  requireAny('hierarchy.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(z.object({ employeeIds: z.array(z.number().int().positive()).max(50) }), req.body);
    res.json({ managers: await HierarchyService.setLocationManagers(currentUser(req), intParam(req.params.id as string), body.employeeIds, clientIp(req)) });
  }),
);

hierarchyRouter.post(
  '/rebuild',
  requireAny('hierarchy.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await HierarchyService.ensureStructure(currentUser(req).id));
  }),
);

hierarchyRouter.get(
  '/locations/:id/hr',
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ hr: await HierarchyService.locationHr(currentUser(req), intParam(req.params.id as string)) });
  }),
);

hierarchyRouter.put(
  '/locations/:id/hr',
  requireAny('hierarchy.manage', 'locations.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseBody(z.object({ employeeIds: z.array(z.number().int().positive()).max(20) }), req.body);
    res.json({ hr: await HierarchyService.setLocationHr(currentUser(req), intParam(req.params.id as string), body.employeeIds, clientIp(req)) });
  }),
);
