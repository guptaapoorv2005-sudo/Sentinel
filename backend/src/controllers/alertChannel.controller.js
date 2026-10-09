import { prisma } from '../config/database.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { configSchemas } from '../validators/alertChannel.validators.js';

// Helper: verify the monitor belongs to the authenticated user.
async function requireMonitorOwnership(monitorId, userId) {
  const monitor = await prisma.monitor.findFirst({
    where: { id: monitorId, userId },
    select: { id: true },
  });
  if (!monitor) throw new ApiError(404, 'Monitor not found');
  return monitor;
}

// Helper: verify a channel belongs to the authenticated user's monitor.
async function requireChannelOwnership(channelId, monitorId, userId) {
  const channel = await prisma.alertChannel.findFirst({
    where: {
      id: channelId,
      monitorId,
      monitor: { userId },
    },
  });
  if (!channel) throw new ApiError(404, 'Alert channel not found');
  return channel;
}

/**
 * POST /api/v1/monitors/:monitorId/alert-channels
 *
 * Create an alert channel for a monitor.
 * At most one channel per type per monitor (enforced by DB unique constraint).
 */
const createAlertChannel = asyncHandler(async (req, res, next) => {
  await requireMonitorOwnership(req.params.monitorId, req.user.id);

  const { type, config, enabled } = req.body;

  let channel;
  try {
    channel = await prisma.alertChannel.create({
      data: {
        monitorId: req.params.monitorId,
        type,
        config,
        enabled,
      },
    });
  } catch (err) {
    // P2002 = unique constraint — channel of this type already exists.
    if (err.code === 'P2002') {
      return next(new ApiError(409, `An ${type} alert channel already exists for this monitor`));
    }
    throw err;
  }

  res.status(201).json(new ApiResponse(201, { channel }, 'Alert channel created'));
});

/**
 * GET /api/v1/monitors/:monitorId/alert-channels
 *
 * List all alert channels for a monitor.
 */
const listAlertChannels = asyncHandler(async (req, res, next) => {
  await requireMonitorOwnership(req.params.monitorId, req.user.id);

  const channels = await prisma.alertChannel.findMany({
    where: { monitorId: req.params.monitorId },
    orderBy: { createdAt: 'asc' },
  });

  res.status(200).json(new ApiResponse(200, { channels }));
});

/**
 * PATCH /api/v1/monitors/:monitorId/alert-channels/:channelId
 *
 * Update a channel's config or enabled state.
 * Channel type is immutable after creation.
 */
const updateAlertChannel = asyncHandler(async (req, res, next) => {
  const channel = await requireChannelOwnership(
    req.params.channelId, req.params.monitorId, req.user.id
  );

  const { config, enabled } = req.body;

  // If config is being updated, validate it against the channel's type-specific schema.
  if (config !== undefined) {
    const configSchema = configSchemas[channel.type];
    if (configSchema) {
      const result = configSchema.safeParse(config);
      if (!result.success) {
        const errors = result.error.issues.map((i) => ({
          field: `config.${i.path.join('.')}`,
          message: i.message,
        }));
        return next(new ApiError(400, 'Validation failed', errors));
      }
    }
  }

  const updateData = {};
  if (config !== undefined)  updateData.config = config;
  if (enabled !== undefined) updateData.enabled = enabled;

  const updated = await prisma.alertChannel.update({
    where: { id: channel.id },
    data: updateData,
  });

  res.status(200).json(new ApiResponse(200, { channel: updated }, 'Alert channel updated'));
});

/**
 * DELETE /api/v1/monitors/:monitorId/alert-channels/:channelId
 *
 * Remove an alert channel. Pending alerts for this channel are also
 * cascade-deleted (via the FK on alerts.channel_id).
 */
const deleteAlertChannel = asyncHandler(async (req, res, next) => {
  const channel = await requireChannelOwnership(
    req.params.channelId, req.params.monitorId, req.user.id
  );

  await prisma.alertChannel.delete({ where: { id: channel.id } });

  res.status(200).json(new ApiResponse(200, {}, 'Alert channel deleted'));
});

/**
 * GET /api/v1/incidents/:incidentId/alerts
 *
 * List outbox events and their alert delivery statuses for an incident.
 * Scoped to the authenticated user.
 */
const listIncidentAlerts = asyncHandler(async (req, res, next) => {
  // Verify the incident belongs to this user.
  const incident = await prisma.incident.findFirst({
    where: {
      id: req.params.incidentId,
      monitor: { userId: req.user.id },
    },
    select: { id: true },
  });
  if (!incident) return next(new ApiError(404, 'Incident not found'));

  const outboxEvents = await prisma.outboxEvent.findMany({
    where: { aggregateType: 'Incident', aggregateId: req.params.incidentId },
    include: {
      alerts: {
        include: {
          channel: {
            select: { type: true, enabled: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.status(200).json(new ApiResponse(200, { outboxEvents }));
});

export {
  createAlertChannel,
  listAlertChannels,
  updateAlertChannel,
  deleteAlertChannel,
  listIncidentAlerts,
};
