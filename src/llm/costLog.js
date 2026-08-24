const PROMPT_VERSION = "maintenance-triage-v1";

/**
 * Write one structured JSON record to stdout for every actual
 * model-call attempt.
 *
 * This intentionally does not log:
 * - the maintenance report
 * - prompts
 * - model output
 * - API keys
 *
 * @param {Object} details
 * @param {"initial"|"repair"} details.callType
 * @param {number} details.attempt
 * @param {number} details.retryCount
 */
export function logModelAttempt({
  callType,
  attempt,
  retryCount,
}) {
  const record = {
    timestamp: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    call_type: callType,
    attempt,
    transport_retry_count: retryCount,
  };

  console.log(JSON.stringify(record));
}