import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/database.js';
import { redis } from '../config/redis.js';
import { config } from '../config/environment.js';
import { ApiResponse } from '../utils/ApiResponse.js';

const router = Router();
router.use(requireAuth);
router.get('/', asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const monitors = await prisma.monitor.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } });
  const ids = monitors.map(m => m.id);
  const [slots, checks, incidents] = await Promise.all([
    prisma.slotResult.findMany({ where: { monitorId: { in: ids }, evaluatedAt: { gte: since } }, select: { monitorId: true, globalStatus: true } }),
    prisma.checkResult.findMany({ where: { monitorId: { in: ids }, checkedAt: { gte: since } }, select: { monitorId: true, responseTimeMs: true, checkedAt: true }, orderBy: { checkedAt: 'asc' } }),
    prisma.incident.findMany({ where: { monitorId: { in: ids } }, include: { events: { orderBy: { createdAt: 'asc' } } }, orderBy: { detectedAt: 'desc' }, take: 100 }),
  ]);
  const analytics = Object.fromEntries(ids.map(id => {
    const known = slots.filter(s => s.monitorId === id && s.globalStatus !== 'UNKNOWN');
    const latencies = checks.filter(c => c.monitorId === id && c.responseTimeMs != null).map(c => c.responseTimeMs).sort((a,b) => a-b);
    const percentile = p => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1] : null;
    return [id, { uptime: known.length ? known.filter(s => s.globalStatus === 'UP').length / known.length * 100 : null, samples: known.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }];
  }));
  res.json(new ApiResponse(200, { monitors, analytics, checks, incidents, since }));
}));
router.get('/events', (req, res) => {
  const expiry = jwt.decode(req.cookies[config.accessTokenCookieName])?.exp * 1000;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const subscriber = redis.duplicate();
  subscriber.on('error', () => {});
  subscriber.subscribe('sentinel:dashboard').then(() => res.write('event: connected\ndata: {}\n\n')).catch(() => res.end());
  subscriber.on('ready', () => res.write('event: connected\ndata: {}\n\n'));
  subscriber.on('message', (_channel, message) => {
    try { const event = JSON.parse(message); if (event.userId === req.user.id) res.write(`event: update\ndata: ${JSON.stringify({ monitorId: event.monitorId })}\n\n`); } catch { /* ignore malformed messages */ }
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  const expires = setTimeout(() => res.end(), Math.max(0, expiry - Date.now()));
  req.on('close', () => { clearInterval(heartbeat); clearTimeout(expires); subscriber.disconnect(); });
});
export default router;
