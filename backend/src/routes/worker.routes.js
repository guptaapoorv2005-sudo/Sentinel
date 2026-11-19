import { Router } from 'express';
import { listWorkers, getWorker, getSchedulerLeader } from '../controllers/worker.controller.js';

const router = Router();

router.get('/', listWorkers);
// Specific route must come before the generic /:workerId param route.
router.get('/scheduler/leader', getSchedulerLeader);
router.get('/:workerId', getWorker);

export default router;
