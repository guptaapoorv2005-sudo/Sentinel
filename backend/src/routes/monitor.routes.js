import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  createMonitorSchema,
  updateMonitorSchema,
  toggleMonitorSchema,
} from '../validators/monitor.validators.js';
import {
  createMonitor,
  listMonitors,
  getMonitor,
  updateMonitor,
  deleteMonitor,
  toggleMonitor,
} from '../controllers/monitor.controller.js';

const router = Router();

router.use(requireAuth);

router.post('/', validate(createMonitorSchema), createMonitor);
router.get('/', listMonitors);
router.get('/:id', getMonitor);
router.put('/:id', validate(updateMonitorSchema), updateMonitor);
router.delete('/:id', deleteMonitor);
router.patch('/:id/status', validate(toggleMonitorSchema), toggleMonitor);

export default router;
