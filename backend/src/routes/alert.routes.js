import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { listIncidentAlerts } from '../controllers/alertChannel.controller.js';

// Mounted under /api/v1/incidents/:incidentId
const alertRouter = Router({ mergeParams: true });
alertRouter.use(requireAuth);

alertRouter.get('/alerts', listIncidentAlerts);

export { alertRouter };
