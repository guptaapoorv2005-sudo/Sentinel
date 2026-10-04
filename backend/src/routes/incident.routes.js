import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { listIncidents, getIncident, acknowledgeIncident } from '../controllers/incident.controller.js';

export const monitorIncidentRouter = Router({ mergeParams: true });
monitorIncidentRouter.use(requireAuth);
monitorIncidentRouter.get('/', listIncidents);

export const incidentRouter = Router();
incidentRouter.use(requireAuth);
incidentRouter.get('/:id', getIncident);
incidentRouter.patch('/:id/acknowledge', acknowledgeIncident);
