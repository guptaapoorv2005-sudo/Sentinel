// HTTP/HTTPS checker for Sentinel workers.
//
// RESPONSIBILITIES:
//   - Execute one HTTP/HTTPS request against a target URL.
//   - Measure total response time with high-resolution timer.
//   - Classify the outcome as UP or DOWN with a specific failure type.
//   - Return a normalized result. Never throw.
//
// FAILURE CLASSIFICATION:
//   null              — check succeeded (status matched expected)
//   UNEXPECTED_STATUS — got a response, but status code != expectedStatus
//   TIMEOUT           — request exceeded the configured timeout
//   DNS_ERROR         — DNS resolution failed
//   CONNECTION_ERROR  — TCP refused / reset
//   NETWORK_ERROR     — catch-all for other network problems
//
// DESIGN: This function is a pure I/O operation with no side effects.
// It does not touch the database or the queue. This makes it easy to
// test in isolation and easy to swap (e.g., for TCP checks later).
//
// TIMEOUT APPROACH:
// Node's built-in fetch supports AbortSignal.timeout() (Node 17.3+).
// We prefer this over wrapping in a manual setTimeout because it
// integrates cleanly with the Fetch API's cancel semantics.

const CHECK_STATUS = {
  UP: 'UP',
  DOWN: 'DOWN',
};

const FAILURE_TYPE = {
  UNEXPECTED_STATUS: 'UNEXPECTED_STATUS',
  TIMEOUT: 'TIMEOUT',
  DNS_ERROR: 'DNS_ERROR',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
};

async function executeCheck({ url, method, timeout, expectedStatus }) {
  const startedAt = performance.now();

  try {
    const signal = AbortSignal.timeout(timeout);

    const response = await fetch(url, {
      method,
      signal,
      // Don't follow redirects automatically for HEAD requests,
      // but allow them for GET (standard web behavior).
      redirect: 'follow',
    });

    const responseTimeMs = Math.round(performance.now() - startedAt);

    if (response.status === expectedStatus) {
      return {
        status: CHECK_STATUS.UP,
        statusCode: response.status,
        responseTimeMs,
        failureType: null,
      };
    } else {
      return {
        status: CHECK_STATUS.DOWN,
        statusCode: response.status,
        responseTimeMs,
        failureType: FAILURE_TYPE.UNEXPECTED_STATUS,
      };
    }
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - startedAt);
    const failureType = classifyFetchError(err);

    return {
      status: CHECK_STATUS.DOWN,
      statusCode: null,
      // For timeouts, we still report elapsed time (= the timeout value).
      // For other errors, it's the time until the error was thrown.
      responseTimeMs,
      failureType,
    };
  }
}

function classifyFetchError(err) {
  const name = err.name || '';
  const message = (err.message || '').toLowerCase();

  // AbortError is thrown when AbortSignal.timeout() fires.
  if (name === 'AbortError' || name === 'TimeoutError') {
    return FAILURE_TYPE.TIMEOUT;
  }

  // DNS resolution failures surface with these patterns across Node versions.
  if (
    message.includes('getaddrinfo') ||
    message.includes('enotfound') ||
    message.includes('dns')
  ) {
    return FAILURE_TYPE.DNS_ERROR;
  }

  // TCP connection refused or reset.
  if (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('econnaborted')
  ) {
    return FAILURE_TYPE.CONNECTION_ERROR;
  }

  return FAILURE_TYPE.NETWORK_ERROR;
}

export { executeCheck, CHECK_STATUS, FAILURE_TYPE };
