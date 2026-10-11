// Alert channel — Webhook delivery.
//
// Sends a JSON POST to the configured URL with an HMAC-SHA256 signature
// header when a secret is configured.
//
// WEBHOOK channel config shape (stored in AlertChannel.config JSON):
//   { url: string, secret?: string }
//
// Signature header: X-Sentinel-Signature: sha256=<hex>
// Computed as:      HMAC-SHA256(secret, JSON.stringify(body))
//
// This allows the recipient to verify the request originated from Sentinel
// (same approach as GitHub webhooks).
//
// sendWebhook() throws on failure (non-2xx, timeout, network error) so the
// dispatcher can record the error and schedule a retry.

import crypto from 'crypto';
import { config } from '../../config/environment.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('alert-dispatcher:webhook');

/**
 * Compute HMAC-SHA256 signature for the payload body.
 * Returns the header value in the format: sha256=<hex>
 */
function computeSignature(secret, body) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Deliver a webhook alert via HTTP POST.
 *
 * @param {object} channelConfig - AlertChannel.config: { url, secret? }
 * @param {string} eventType     - OutboxEvent.type
 * @param {object} payload       - OutboxEvent.payload
 * @throws if delivery fails (dispatcher will retry)
 */
async function sendWebhook(channelConfig, eventType, payload) {
  const { url, secret } = channelConfig;
  if (!url) throw new Error('Webhook channel config missing required field: url');

  const body = JSON.stringify({
    type: eventType,
    ...payload,
    sentinelVersion: '1.0',
    timestamp: new Date().toISOString(),
  });

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Sentinel-AlertDispatcher/1.0',
  };

  if (secret) {
    headers['X-Sentinel-Signature'] = computeSignature(secret, body);
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
    });
  } catch (err) {
    // Network error or timeout
    throw new Error(`Webhook delivery failed (network): ${err.message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Webhook returned ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`
    );
  }

  logger.info({ url, eventType, status: response.status }, 'Webhook delivered');
}

export { sendWebhook };
