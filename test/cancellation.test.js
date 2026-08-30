import test from "node:test";
import assert from "node:assert/strict";

import { withTransportRetry, TransportError } from "../src/llm/retry.js";
import { APIConnectionTimeoutError, APIUserAbortError } from "openai";

// -----------------------------------------------------------------------
// These tests prove the two behaviors that were previously unverified:
//
//   1. A real SDK timeout, with NO caller signal firing, still retries
//      normally (proves the cancellation change didn't break the
//      existing retry path).
//   2. A caller-triggered abort (the workflow deadline in production)
//      stops retries immediately, classifies as "cancelled" (not
//      "timeout"), and does so even mid-backoff rather than waiting out
//      the sleep.
// -----------------------------------------------------------------------

test("SDK timeout with no caller signal still retries normally", async () => {
  let attempts = 0;

  const operation = async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new APIConnectionTimeoutError();
    }
    return "ok";
  };

  const result = await withTransportRetry(operation, {
    maxRetries: 2,
    sleepFn: async () => {},
    callType: "test",
    // no signal passed — mirrors any caller that doesn't opt into cancellation
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("caller abort stops retries immediately and classifies as 'cancelled', not 'timeout'", async () => {
  const controller = new AbortController();
  let attempts = 0;

  const operation = async () => {
    attempts += 1;
    // Simulate: the abort happens, the SDK call rejects with the SDK's
    // own abort-shaped error (this is what actually happens once signal
    // is wired into chat.completions.create).
    controller.abort();
    throw new APIUserAbortError();
  };

  await assert.rejects(
    () =>
      withTransportRetry(operation, {
        maxRetries: 2,
        sleepFn: async () => {},
        callType: "test",
        signal: controller.signal,
      }),
    (error) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.kind, "cancelled");
      assert.equal(error.retryable, false);
      return true;
    }
  );

  // Aborted on the first attempt — must not have tried again.
  assert.equal(attempts, 1);
});

test("abort during backoff sleep stops the retry immediately, without waiting out the delay", async () => {
  const controller = new AbortController();
  let attempts = 0;

  const operation = async () => {
    attempts += 1;
    throw new APIConnectionTimeoutError(); // retryable, so it will reach the backoff sleep
  };

  const { setTimeout: timersSetTimeout } = await import(
    "node:timers/promises"
  );

  // Real sleep (not a stub), matching retry.js's own sleepFn(ms, signal)
  // call shape, so we can prove the abort actually interrupts it rather
  // than the test racing a stub that never really waits.
  const realSleepFn = (ms, signal) =>
    timersSetTimeout(ms, undefined, { signal });

  const startedAt = Date.now();

  // Abort partway through what would otherwise be a much longer backoff.
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    () =>
      withTransportRetry(operation, {
        maxRetries: 2,
        sleepFn: realSleepFn,
        random: () => 0, // deterministic backoff timing
        callType: "test",
        signal: controller.signal,
      }),
    (error) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.kind, "cancelled");
      assert.equal(error.retryable, false);
      return true;
    }
  );

  const elapsedMs = Date.now() - startedAt;

  // The default backoff after one retryable failure is 1000ms. If abort
  // didn't interrupt the sleep, this test would take >=1000ms. It should
  // instead resolve close to when the abort fired (~20ms).
  assert.ok(
    elapsedMs < 500,
    `expected abort to interrupt backoff quickly, took ${elapsedMs}ms`
  );

  // Only the one attempt that led into the backoff should have run.
  assert.equal(attempts, 1);
});