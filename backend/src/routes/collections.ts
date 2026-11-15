import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, intParam, parseBody } from '../lib/http.js';
import { authenticate, currentUser, requirePermission } from '../middleware/auth.js';
import { CollectionService } from '../services/CollectionService.js';
import type { AuthedRequest } from '../middleware/auth.js';

export const collectionsRouter = Router();
collectionsRouter.use(authenticate);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const collectionInput = z.object({
  customerName: z.string().min(2).max(160),
  customerContact: z.string().max(40).optional().nullable(),
  invoiceNo: z.string().max(80).optional().nullable(),
  amountDue: z.number().positive().max(99_999_999_999),
  amountCollected: z.number().min(0).max(99_999_999_999).optional(),
  currency: z.string().length(3).optional(),
  paymentMode: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other']).optional().nullable(),
  dueDate: dateString,
  collectedOn: dateString.optional().nullable(),
  employeeId: z.number().int().positive().optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  locationId: z.number().int().positive().nullable().optional(),
  notes: z.string().max(1000).optional().nullable(),
});

collectionsRouter.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    res.json(CollectionService.statuses());
  }),
);

collectionsRouter.get(
  '/dashboard',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(
      await CollectionService.dashboard(user, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
    );
  }),
);

collectionsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const filters = {
      search: req.query.search ? String(req.query.search) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      approvalStatus: req.query.approvalStatus ? String(req.query.approvalStatus) : undefined,
      employeeId: req.query.employeeId ? intParam(String(req.query.employeeId), 'employeeId') : undefined,
      departmentId: req.query.departmentId ? intParam(String(req.query.departmentId), 'departmentId') : undefined,
      locationId: req.query.locationId ? intParam(String(req.query.locationId), 'locationId') : undefined,
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
      page: req.query.page ? intParam(String(req.query.page), 'page') : undefined,
      pageSize: req.query.pageSize ? intParam(String(req.query.pageSize), 'pageSize') : undefined,
    };
    res.json(await CollectionService.list(user, filters));
  }),
);

collectionsRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    res.json(await CollectionService.detail(user, intParam(String(req.params.id), 'id')));
  }),
);

collectionsRouter.post(
  '/',
  requirePermission('collections.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const input = parseBody(collectionInput, req.body);
    res.status(201).json(await CollectionService.create(user, input));
  }),
);

collectionsRouter.patch(
  '/:id',
  requirePermission('collections.edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      collectionInput.partial().extend({ status: z.enum(['pending', 'partial', 'collected', 'cancelled']).optional() }),
      req.body,
    );
    res.json(await CollectionService.update(user, intParam(String(req.params.id), 'id'), body));
  }),
);

collectionsRouter.post(
  '/:id/decision',
  requirePermission('collections.approve'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({ approve: z.boolean(), reason: z.string().max(400).optional() }),
      req.body,
    );
    res.json(await CollectionService.decide(user, intParam(String(req.params.id), 'id'), body.approve, body.reason));
  }),
);

collectionsRouter.delete(
  '/:id',
  requirePermission('collections.delete'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    await CollectionService.remove(user, intParam(String(req.params.id), 'id'));
    res.status(204).end();
  }),
);
