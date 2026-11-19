import { redis } from '../config/redis.js';
import { createLogger } from './logger.js';
const logger = createLogger('dashboard-events');
// Best-effort hints must not block or change the result of committed writes.
export function notifyDashboard(userId, monitorId) {
  if (redis.status !== 'ready') return;
  redis.publish('sentinel:dashboard', JSON.stringify({ userId, monitorId }))
    .catch(err => logger.warn({ err: err.message }, 'Dashboard notification failed'));
}
