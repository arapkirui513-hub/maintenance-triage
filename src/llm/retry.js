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

/**
 * Sleep for `ms` milliseconds, or reject immediately if `signal` fires
 * before the delay completes.
 *
 * Without this, a caller cancellation (e.g. the workflow deadline) would
 * only take effect after the current backoff finishes, up to ~2.25s of
 * avoidable delay with the current BACKOFF_DELAYS_MS + jitter.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true }
    );
  });
}

/**
 * Execute an async operation with bounded transport retries.
 *
 * This layer knows only about transport failures.
 * It does not know about JSON, Zod, model-output repair, or HTTP routing.
 *
 * Caller cancellation (via `signal`) always takes precedence over normal
 * transport-error classification: if the signal has fired, the operation
 * is not retried regardless of what kind of error came back. This keeps
 * isTimeoutError()/classifyError() scoped to "what kind of transport
 * failure is this?" and leaves "should this attempt continue?" to this
 * function.
 *
 * @param {Function} operation
 * @param {Object} options
 * @param {number} options.maxRetries
 * @param {Function} options.sleepFn
 * @param {Function} options.random
 * @param {string} options.callType
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<*>}
 */
export async function withTransportRetry(
  operation,
  {
    maxRetries = MAX_RETRIES,
    sleepFn = sleep,
    random = Math.random,
    callType = "unknown",
    signal,
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
      // Caller cancellation always wins, before normal classification.
      // A cancelled attempt is never retried, regardless of what shape
      // the resulting error happens to take.
      if (signal?.aborted) {
        throw new TransportError({
          message:
            error instanceof Error ? error.message : String(error),
          kind: "cancelled",
          status: null,
          retryable: false,
          attempts: retryCount + 1,
          retryCount,
          retryAfterMs: null,
          cause: error,
        });
      }

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

      try {
        await sleepFn(delayMs, signal);
      } catch (sleepError) {
        // The backoff itself was interrupted by cancellation. Throw the
        // same TransportError shape as an in-flight-operation abort, so
        // callers (and mapTransportError in the route) have one
        // consistent contract regardless of *when* the abort landed.
        throw new TransportError({
          message:
            sleepError instanceof Error
              ? sleepError.message
              : String(sleepError),
          kind: "cancelled",
          status: null,
          retryable: false,
          attempts: retryCount,
          retryCount,
          retryAfterMs: null,
          cause: sleepError,
        });
      }
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