import { prisma } from '../config/database.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('monitors');

const createMonitor = asyncHandler(async (req, res, next) => {
  const monitor = await prisma.monitor.create({
    data: {
      ...req.body,
      userId: req.user.id,
    },
  });

  // logger.info({ monitorId: monitor.id, userId: req.user.id }, 'Monitor created');

  res.status(201).json(new ApiResponse(201, { monitor }, 'Monitor created'));
});

const listMonitors = asyncHandler(async (req, res, next) => {
  const monitors = await prisma.monitor.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json(new ApiResponse(200, { monitors }));
});

const getMonitor = asyncHandler(async (req, res, next) => {
  const monitor = await prisma.monitor.findFirst({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!monitor) {
    return next(new ApiError(404, 'Monitor not found'));
  }

  res.status(200).json(new ApiResponse(200, { monitor }));
});

const updateMonitor = asyncHandler(async (req, res, next) => {
  const existing = await prisma.monitor.findFirst({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!existing) {
    return next(new ApiError(404, 'Monitor not found'));
  }

  const monitor = await prisma.monitor.update({
    where: { id: existing.id },
    data: req.body,
  });

  // logger.info({ monitorId: monitor.id }, 'Monitor updated');

  res.status(200).json(new ApiResponse(200, { monitor }, 'Monitor updated'));
});

const deleteMonitor = asyncHandler(async (req, res, next) => {
  const existing = await prisma.monitor.findFirst({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!existing) {
    return next(new ApiError(404, 'Monitor not found'));
  }

  await prisma.monitor.delete({ where: { id: existing.id } });

  // logger.info({ monitorId: existing.id }, 'Monitor deleted');

  res.status(200).json(new ApiResponse(200, null, 'Monitor deleted'));
});

const toggleMonitor = asyncHandler(async (req, res, next) => {
  const existing = await prisma.monitor.findFirst({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!existing) {
    return next(new ApiError(404, 'Monitor not found'));
  }

  const monitor = await prisma.monitor.update({
    where: { id: existing.id },
    data: { enabled: req.body.enabled },
  });

  // logger.info(
  //   { monitorId: monitor.id, enabled: monitor.enabled },
  //   'Monitor status toggled'
  // );

  res.status(200).json(new ApiResponse(200, { monitor }, 'Monitor status updated'));
});

export { createMonitor, listMonitors, getMonitor, updateMonitor, deleteMonitor, toggleMonitor };
