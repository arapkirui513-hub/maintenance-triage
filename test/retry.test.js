import test from "node:test";
import assert from "node:assert/strict";

import {
  isTimeoutError,
  classifyError,
  withTransportRetry,
  TransportError,
} from "../src/llm/retry.js";

import {
  APIConnectionTimeoutError,
  APIUserAbortError,
  APIConnectionError,
  APIError,
} from "openai";

// -----------------------------------------------------------------------
// These tests are built against the actual error classes exported by the
// pinned `openai` SDK, not hand-built mock shapes. The bug this guards
// against: the SDK's error subclasses never override `Error.prototype.name`,
// so `error.name` is the literal string "Error" for every one of them, and
// `.code` is undefined. A naive `error.name === "AbortError"` /
// `error.code === "ETIMEDOUT"` check silently never matches a real SDK
// timeout or abort. See BUILDLOG.md for the investigation.
// -----------------------------------------------------------------------

test("isTimeoutError matches a real APIConnectionTimeoutError instance", () => {
  const err = new APIConnectionTimeoutError();
  assert.equal(isTimeoutError(err), true);
});

test("isTimeoutError matches a real APIUserAbortError instance", () => {
  const err = new APIUserAbortError();
  assert.equal(isTimeoutError(err), true);
});

test("isTimeoutError does NOT match a plain APIConnectionError (non-timeout connection failure)", () => {
  const err = new APIConnectionError({ message: "fetch failed" });
  assert.equal(isTimeoutError(err), false);
});

test("isTimeoutError does NOT match a generic Error", () => {
  const err = new Error("some unrelated failure");
  assert.equal(isTimeoutError(err), false);
});

test("isTimeoutError still matches native AbortController/DOMException shape", () => {
  // What a raw fetch(..., { signal }) abort produces, independent of the
  // openai SDK. Must keep working once AbortController is wired into
  // client.js.
  const err = { name: "AbortError", code: 20 };
  assert.equal(isTimeoutError(err), true);
});

test("isTimeoutError still matches legacy Node socket timeout codes", () => {
  assert.equal(isTimeoutError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTimeoutError({ code: "ECONNABORTED" }), true);
});

test("classifyError reports kind 'timeout' for a real SDK timeout", () => {
  const err = new APIConnectionTimeoutError();
  const result = classifyError(err);
  assert.equal(result.kind, "timeout");
  assert.equal(result.retryable, true);
});

test("classifyError reports kind 'timeout' for a real SDK user-abort error", () => {
  const err = new APIUserAbortError();
  const result = classifyError(err);
  assert.equal(result.kind, "timeout");
  assert.equal(result.retryable, true);
});

test("classifyError does NOT misclassify a real rate-limit error as timeout", () => {
  // Built via the SDK's own factory so the shape is authentic, not guessed.
  const err = APIError.generate(429, { error: { message: "rate limited" } }, "rate limited", {});
  const result = classifyError(err);
  assert.equal(result.kind, "rate_limit");
  assert.notEqual(result.kind, "timeout");
});

test("classifyError falls back to network_error for an unrelated failure", () => {
  const err = new Error("DNS lookup failed");
  const result = classifyError(err);
  assert.equal(result.kind, "network_error");
});

// -----------------------------------------------------------------------
// Integration-level check: confirm the fix changes real behavior in
// withTransportRetry, not just in isolated unit calls.
// -----------------------------------------------------------------------

test("withTransportRetry exhausts retries on a real SDK timeout and throws TransportError with kind 'timeout'", async () => {
  let attempts = 0;

  const failingOperation = async () => {
    attempts += 1;
    throw new APIConnectionTimeoutError();
  };

  await assert.rejects(
    () =>
      withTransportRetry(failingOperation, {
        maxRetries: 2,
        sleepFn: async () => {}, // no real delay in tests
        callType: "test",
      }),
    (error) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 3); // 1 initial + 2 retries
      return true;
    }
  );

  assert.equal(attempts, 3);
});

test("withTransportRetry succeeds if a real SDK timeout resolves on a later attempt", async () => {
  let attempts = 0;

  const flakyThenSucceeds = async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new APIConnectionTimeoutError();
    }
    return "ok";
  };

  const result = await withTransportRetry(flakyThenSucceeds, {
    maxRetries: 2,
    sleepFn: async () => {},
    callType: "test",
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});