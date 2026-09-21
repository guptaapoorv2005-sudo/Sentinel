import { Router } from 'express';
import { listWorkers, getWorker } from '../controllers/worker.controller.js';

const router = Router();

router.get('/', listWorkers);
router.get('/:workerId', getWorker);

export default router;
