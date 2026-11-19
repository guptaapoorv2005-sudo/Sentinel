// Runs the API and background processes together as a single web service.
// Each child inherits the service environment and receives its own identity.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const regions = (process.env.QUORUM_REGIONS || 'default')
  .split(',')
  .map((region) => region.trim());
const quorum = Number(process.env.QUORUM_MIN_REGIONS || 1);

if (regions.some((region) => !/^[a-zA-Z0-9_-]+$/.test(region)) ||
    new Set(regions).size !== regions.length ||
    !Number.isInteger(quorum) || quorum < 1 || quorum > regions.length) {
  console.error('Invalid QUORUM_REGIONS or QUORUM_MIN_REGIONS configuration');
  process.exit(1);
}

// Unique even when Render overlaps old and new instances during a deployment.
const instanceId = randomUUID();
const processes = [
  { name: 'api', script: 'src/index.js' },
  {
    name: 'scheduler',
    script: 'src/scheduler/index.js',
    env: { SCHEDULER_ID: `scheduler-${instanceId}` },
  },
  ...regions.map((region) => ({
    name: `worker-${region}`,
    script: 'src/worker/index.js',
    env: {
      WORKER_ID: `worker-${region}-${instanceId}`,
      WORKER_REGION: region,
    },
  })),
  {
    name: 'result-processor',
    script: 'src/result-processor/index.js',
    env: { WORKER_ID: `processor-${instanceId}` },
  },
  {
    name: 'alert-dispatcher',
    script: 'src/alert-dispatcher/index.js',
    env: { WORKER_ID: `dispatcher-${instanceId}` },
  },
];

const children = new Map();
let shuttingDown = false;
let exitStatus = 0;
let shutdownTimer;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitStatus = code;

  for (const child of children.values()) child.kill('SIGTERM');
  if (children.size === 0) process.exit(exitStatus);

  shutdownTimer = setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(exitStatus);
  }, 10_000);
  shutdownTimer.unref();
}

for (const definition of processes) {
  const child = spawn(process.execPath, [definition.script], {
    env: { ...process.env, ...definition.env },
    stdio: 'inherit',
  });
  children.set(definition.name, child);

  child.on('error', (error) => {
    console.error(`[supervisor] ${definition.name} could not start:`, error.message);
    shutdown(1);
  });

  child.on('close', (code, signal) => {
    children.delete(definition.name);
    if (!shuttingDown) {
      console.error(`[supervisor] ${definition.name} exited unexpectedly`, { code, signal });
      shutdown(1);
    }
    if (shuttingDown && children.size === 0) {
      clearTimeout(shutdownTimer);
      process.exit(exitStatus);
    }
  });
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
