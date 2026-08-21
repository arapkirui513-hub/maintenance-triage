import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LOG_DIR = path.resolve("logs");
const QUARANTINE_PATH = path.join(LOG_DIR, "quarantine.jsonl");

function hashInput(input) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(input, "utf8")
    .digest("hex")}`;
}

export function quarantineFailure({
  input,
  promptVersion,
  originalOutput,
  repairOutput,
  validationError,
  repairCount,
}) {
  mkdirSync(LOG_DIR, { recursive: true });

  const record = {
    timestamp: new Date().toISOString(),
    prompt_version: promptVersion,
    input_hash: hashInput(input),
    original_output: originalOutput,
    repair_output: repairOutput,
    validation_error: validationError,
    repair_count: repairCount,
  };

  appendFileSync(
    QUARANTINE_PATH,
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
}