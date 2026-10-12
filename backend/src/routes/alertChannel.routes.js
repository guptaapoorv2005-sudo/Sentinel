import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
  createAlertChannel,
  listAlertChannels,
  updateAlertChannel,
  deleteAlertChannel,
} from '../controllers/alertChannel.controller.js';
import {
  createAlertChannelSchema,
  updateAlertChannelSchema,
} from '../validators/alertChannel.validators.js';

// Mounted under /api/v1/monitors/:monitorId/alert-channels (mergeParams: true)
const alertChannelRouter = Router({ mergeParams: true });
alertChannelRouter.use(requireAuth);

alertChannelRouter.post(
  '/',
  validate(createAlertChannelSchema),
  createAlertChannel
);

alertChannelRouter.get('/', listAlertChannels);

alertChannelRouter.patch(
  '/:channelId',
  validate(updateAlertChannelSchema),
  updateAlertChannel
);

alertChannelRouter.delete('/:channelId', deleteAlertChannel);

export { alertChannelRouter };
