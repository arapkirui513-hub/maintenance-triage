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

/**
 * Write one structured JSON record after a successful model call.
 *
 * Logs provider/model usage metadata only.
 * Does not log prompts, maintenance reports, or model output.
 *
 * @param {Object} details
 * @param {"initial"|"repair"} details.callType
 * @param {string} details.model
 * @param {number|null} details.inputTokens
 * @param {number|null} details.outputTokens
 * @param {number} details.durationMs
 */
export function logModelCompletion({
  callType,
  model,
  inputTokens,
  outputTokens,
  durationMs,
}) {
  const record = {
    timestamp: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    call_type: callType,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: durationMs,
  };

  console.log(JSON.stringify(record));
}