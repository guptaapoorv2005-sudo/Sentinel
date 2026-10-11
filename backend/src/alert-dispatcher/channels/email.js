// Alert channel — Email delivery via Resend (https://resend.com).
//
// Resend is a transactional email API with a simple HTTP-based SDK.
// We create one Resend client instance (module-level) reused across all sends.
//
// EMAIL channel config shape (stored in AlertChannel.config JSON):
//   { to: string }   — recipient email address
//
// sendEmail() throws on delivery failure so the dispatcher can
// record the error and schedule a retry.

import { Resend } from 'resend';
import { config } from '../../config/environment.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('alert-dispatcher:email');

// Lazy-initialise the Resend client so we don't crash at startup if the
// API key is not configured (email channel simply won't be usable).
let resend = null;
function getResendClient() {
  if (!resend) {
    if (!config.resendApiKey) {
      throw new Error('RESEND_API_KEY is not configured — email alerts are disabled');
    }
    resend = new Resend(config.resendApiKey);
  }
  return resend;
}

// ── HTML email templates ───────────────────────────────────────────────────────

function renderConfirmedEmail(payload) {
  const { monitorName, monitorUrl, consecutiveFailures, detectedAt } = payload;
  return {
    subject: `🔴 Incident: ${monitorName} is DOWN`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc2626;">🔴 Monitor Down — ${monitorName}</h2>
        <p>Sentinel has detected a confirmed outage for one of your monitors.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; width: 40%;">Monitor</td>
            <td style="padding: 8px;">${monitorName}</td>
          </tr>
          <tr style="background: #f9fafb;">
            <td style="padding: 8px; font-weight: bold;">URL</td>
            <td style="padding: 8px;"><a href="${monitorUrl}">${monitorUrl}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold;">Consecutive Failures</td>
            <td style="padding: 8px;">${consecutiveFailures}</td>
          </tr>
          <tr style="background: #f9fafb;">
            <td style="padding: 8px; font-weight: bold;">Detected At</td>
            <td style="padding: 8px;">${new Date(detectedAt).toUTCString()}</td>
          </tr>
        </table>
        <p style="color: #6b7280; font-size: 12px;">
          This alert was sent by Sentinel. You can acknowledge this incident in your dashboard.
        </p>
      </div>
    `,
  };
}

function renderResolvedEmail(payload) {
  const { monitorName, monitorUrl, resolvedAt, durationMs } = payload;
  const durationStr = durationMs
    ? (() => {
      const s = Math.floor(durationMs / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return `${h}h ${m % 60}m`;
      if (m > 0) return `${m}m ${s % 60}s`;
      return `${s}s`;
    })()
    : 'unknown';

  return {
    subject: `✅ Resolved: ${monitorName} is back UP`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a;">✅ Monitor Recovered — ${monitorName}</h2>
        <p>The incident has been resolved. Your monitor is responding normally again.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px; font-weight: bold; width: 40%;">Monitor</td>
            <td style="padding: 8px;">${monitorName}</td>
          </tr>
          <tr style="background: #f9fafb;">
            <td style="padding: 8px; font-weight: bold;">URL</td>
            <td style="padding: 8px;"><a href="${monitorUrl}">${monitorUrl}</a></td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold;">Resolved At</td>
            <td style="padding: 8px;">${new Date(resolvedAt).toUTCString()}</td>
          </tr>
          <tr style="background: #f9fafb;">
            <td style="padding: 8px; font-weight: bold;">Outage Duration</td>
            <td style="padding: 8px;">${durationStr}</td>
          </tr>
        </table>
        <p style="color: #6b7280; font-size: 12px;">
          This alert was sent by Sentinel.
        </p>
      </div>
    `,
  };
}

// ── sendEmail ─────────────────────────────────────────────────────────────────

async function sendEmail(channelConfig, eventType, payload) {
  const { to } = channelConfig;
  if (!to) throw new Error('Email channel config missing required field: to');

  const client = getResendClient();

  const { subject, html } =
    eventType === 'INCIDENT_CONFIRMED'
      ? renderConfirmedEmail(payload)
      : renderResolvedEmail(payload);

  const { data, error } = await client.emails.send({
    from: config.resendFrom,
    to,
    subject,
    html,
  });

  if (error) {
    logger.warn({ to, eventType, error }, 'Resend API returned an error');
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }

  logger.info({ to, eventType, messageId: data?.id }, 'Email delivered via Resend');
}

export { sendEmail };
