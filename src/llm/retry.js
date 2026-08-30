import { logModelAttempt } from "./costLog.js";
import { APIConnectionTimeoutError, APIUserAbortError } from "openai";

const MAX_RETRIES = 2;
const BACKOFF_DELAYS_MS = [1000, 2000];

export class TransportError extends Error {
  constructor({
    message,
    kind,
    status = null,
    retryable = false,
    attempts = 0,
    retryCount = 0,
    retryAfterMs = null,
    cause = null,
  }) {
    super(message);

    this.name = "TransportError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
    this.retryCount = retryCount;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

function isTimeoutError(error) {
  return (
    error instanceof APIConnectionTimeoutError ||
    error instanceof APIUserAbortError ||
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNABORTED"
  );
}

function getStatus(error) {
  return error?.status ?? error?.response?.status ?? null;
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function getRetryAfterMs(error) {
  const retryAfter =
    error?.headers?.["retry-after"] ??
    error?.headers?.get?.("retry-after") ??
    error?.response?.headers?.["retry-after"] ??
    error?.response?.headers?.get?.("retry-after");

  if (retryAfter == null) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryDate = Date.parse(retryAfter);

  if (!Number.isNaN(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return null;
}

function classifyError(error) {
  const status = getStatus(error);

  if (isTimeoutError(error)) {
    return {
      kind: "timeout",
      status: null,
      retryable: true,
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      retryable: true,
    };
  }

  if (status >= 500 && status <= 599) {
    return {
      kind: "upstream_5xx",
      status,
      retryable: true,
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: "upstream_auth",
      status,
      retryable: false,
    };
  }

  if (status >= 400 && status <= 499) {
    return {
      kind: "upstream_4xx",
      status,
      retryable: false,
    };
  }

  return {
    kind: "network_error",
    status: null,
    retryable: true,
  };
}

function getBackoffMs(retryNumber, retryAfterMs, random = Math.random) {
  // Provider-directed Retry-After always takes precedence.
  if (retryAfterMs != null) {
    return retryAfterMs;
  }

  const baseDelay =
    BACKOFF_DELAYS_MS[retryNumber - 1] ??
    BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];

  // Add a small random jitter to the locked 1s / 2s backoff.
  // This avoids synchronized retries while preserving the minimum delay.
  const jitter = Math.floor(random() * 250);

  return baseDelay + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Execute an async operation with bounded transport retries.
 *
 * This layer knows only about transport failures.
 * It does not know about JSON, Zod, model-output repair, or HTTP routing.
 *
 * @param {Function} operation
 * @param {Object} options
 * @param {number} options.maxRetries
 * @param {Function} options.sleepFn
 * @param {Function} options.random
 * @param {string} options.callType
 * @returns {Promise<*>}
 */
export async function withTransportRetry(
  operation,
  {
    maxRetries = MAX_RETRIES,
    sleepFn = sleep,
    random = Math.random,
    callType = "unknown",
  } = {}
) {
  let retryCount = 0;

  while (true) {
    try {
      const attempt = retryCount + 1;

      logModelAttempt({
        callType,
        attempt,
        retryCount,
      });

      return await operation({
        attempt,
        retryCount,
        callType,
      });
    } catch (error) {
      const classification = classifyError(error);
      const status = classification.status;

      if (!classification.retryable || retryCount >= maxRetries) {
        throw new TransportError({
          message:
            error instanceof Error
              ? error.message
              : String(error),
          kind: classification.kind,
          status,
          retryable: classification.retryable,
          attempts: retryCount + 1,
          retryCount,
          retryAfterMs: getRetryAfterMs(error),
          cause: error,
        });
      }

      retryCount += 1;

      const retryAfterMs = getRetryAfterMs(error);

      const delayMs = getBackoffMs(
        retryCount,
        retryAfterMs,
        random
      );

      await sleepFn(delayMs);
    }
  }
}

export {
  MAX_RETRIES,
  BACKOFF_DELAYS_MS,
  classifyError,
  getBackoffMs,
  getRetryAfterMs,
  isRetryableStatus,
  isTimeoutError,
};