import { prisma } from '../config/database.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Helper: verify the incident belongs to the authenticated user's monitor.
// Returns the incident or throws a 404 ApiError.
async function requireIncidentOwnership(incidentId, userId) {
  const incident = await prisma.incident.findFirst({
    where: {
      id: incidentId,
      monitor: { userId },
    },
    include: {
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!incident) throw new ApiError(404, 'Incident not found');
  return incident;
}

/**
 * GET /api/v1/monitors/:monitorId/incidents
 *
 * List incidents for a specific monitor, newest first.
 * Scoped to the authenticated user's monitors.
 *
 * Query params:
 *   status  - filter by IncidentStatus (optional)
 *   limit   - max results (default 20, max 100)
 *   offset  - pagination offset (default 0)
 */
const listIncidents = asyncHandler(async (req, res, next) => {
  // Confirm the monitor exists and belongs to this user.
  const monitor = await prisma.monitor.findFirst({
    where: { id: req.params.monitorId, userId: req.user.id },
    select: { id: true },
  });

  if (!monitor) return next(new ApiError(404, 'Monitor not found'));

  const { status, limit = 20, offset = 0 } = req.query;
  const take = Math.min(parseInt(limit, 10) || 20, 100);
  const skip = parseInt(offset, 10) || 0;

  const where = { monitorId: monitor.id };
  if (status) where.status = status;

  const [incidents, total] = await Promise.all([
    prisma.incident.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take,
      skip,
      include: {
        events: { orderBy: { createdAt: 'asc' } },
      },
    }),
    prisma.incident.count({ where }),
  ]);

  res.status(200).json(new ApiResponse(200, { incidents, total, limit: take, offset: skip }));
});

/**
 * GET /api/v1/incidents/:id
 *
 * Get a single incident by ID, including its full event timeline.
 * Returns 404 if the incident does not belong to the user's monitor.
 */
const getIncident = asyncHandler(async (req, res, next) => {
  const incident = await requireIncidentOwnership(req.params.id, req.user.id).catch(
    (err) => next(err)
  );
  if (!incident) return;

  res.status(200).json(new ApiResponse(200, { incident }));
});

/**
 * PATCH /api/v1/incidents/:id/acknowledge
 *
 * Acknowledge an open incident (DETECTED or CONFIRMED → ACKNOWLEDGED).
 * Idempotent: re-acknowledging an ACKNOWLEDGED incident returns 200.
 * Cannot acknowledge a RESOLVED incident.
 */
const acknowledgeIncident = asyncHandler(async (req, res, next) => {
  const incident = await requireIncidentOwnership(req.params.id, req.user.id).catch(
    (err) => next(err)
  );
  if (!incident) return;

  if (incident.status === 'RESOLVED') {
    return next(new ApiError(400, 'Cannot acknowledge a resolved incident'));
  }

  if (incident.status === 'ACKNOWLEDGED') {
    // Already acknowledged — idempotent success.
    return res.status(200).json(new ApiResponse(200, { incident }, 'Incident already acknowledged'));
  }

  const prevStatus = incident.status;
  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const upd = await tx.incident.update({
      where: { id: incident.id },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: now },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

    await tx.incidentEvent.create({
      data: {
        incidentId: incident.id,
        fromStatus: prevStatus,
        toStatus: 'ACKNOWLEDGED',
        reason: 'user_acknowledged',
        actor: req.user.id,
      },
    });

    return upd;
  });

  res.status(200).json(new ApiResponse(200, { incident: updated }, 'Incident acknowledged'));
});

export { listIncidents, getIncident, acknowledgeIncident };
