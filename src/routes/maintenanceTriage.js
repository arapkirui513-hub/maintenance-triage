import { Router } from "express";
import { InputSchema } from "../llm/schema.js";
import { classifyMaintenanceReport } from "../llm/client.js";
import { parseAndRepair } from "../llm/parser.js";

import { applyConfidencePolicy } from "../llm/policy.js";
import { TransportError } from "../llm/retry.js";

const router = Router();

const WORKFLOW_DEADLINE_MS = 60_000;

class WorkflowDeadlineError extends Error {
  constructor() {
    super("Maintenance triage workflow exceeded the 60 second deadline.");
    this.name = "WorkflowDeadlineError";
  }
}

function withWorkflowDeadline(promise, timeoutMs = WORKFLOW_DEADLINE_MS) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new WorkflowDeadlineError());
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function mapTransportError(error) {
  if (!(error instanceof TransportError)) {
    return null;
  }

  switch (error.kind) {
    case "timeout":
      return {
        status: 504,
        body: {
          error: "upstream_timeout",
          message: "The model request timed out.",
        },
      };

    case "rate_limit":
      return {
        status: 429,
        body: {
          error: "upstream_rate_limit",
          message: "The model provider rate limit was exhausted after retries.",
        },
      };

    case "upstream_5xx":
      return {
        status: 502,
        body: {
          error: "upstream_failure",
          message: "The model provider failed after transport retries.",
        },
      };

    case "upstream_auth":
      return {
        status: 500,
        body: {
          error: "model_configuration_error",
          message: "The model provider rejected the configured credentials.",
        },
      };

    case "upstream_4xx":
      return {
        status: 500,
        body: {
          error: "model_provider_error",
          message: "The model provider rejected the request.",
        },
      };

    default:
      return {
        status: 502,
        body: {
          error: "model_transport_error",
          message: "The model provider could not be reached.",
        },
      };
  }
}

router.post("/maintenance-triage", async (req, res) => {
  // 1. Validate input before spending any model call.
  const inputResult = InputSchema.safeParse(req.body);

  if (!inputResult.success) {
    const issue = inputResult.error.issues[0];

    return res.status(400).json({
      error: "invalid_input",
      field: issue.path.join(".") || "text",
      message: issue.message,
    });
  }

  // 2. Kill switch.
  //    When disabled, the system refuses to guess rather than returning
  //    a deterministic fallback classification.
  if (process.env.LLM_ENABLED !== "true") {
    return res.status(503).json({
      error: "llm_disabled",
      message: "The AI classification service is currently disabled.",
    });
  }

  const { text } = inputResult.data;

  try {
    const result = await withWorkflowDeadline(
      (async () => {
        // 3. Initial model call.
        const rawText = await classifyMaintenanceReport(text);

        // 4. Parse and validate the model output.
        //    parser.js gets exactly one repair attempt if needed.
        const parsedResult = await parseAndRepair({
          input: text,
          initialOutput: rawText,
        });

        return parsedResult;
      })()
    );

    // 5. Model output remained invalid after the one permitted repair.
    if (!result.success) {
      return res.status(422).json({
        error: "invalid_model_output",
        message:
          "Model output could not be validated after one repair attempt.",
        repair_count: result.repairCount,
      });
    }

    // 6. Apply deterministic application policy.
    const finalResult = applyConfidencePolicy(result.data);

    return res.status(200).json(finalResult);
  } catch (error) {
    // The outer 60-second deadline has its own error contract.
    if (error instanceof WorkflowDeadlineError) {
      return res.status(504).json({
        error: "workflow_timeout",
        message:
          "The maintenance triage workflow exceeded the 60 second deadline.",
      });
    }

    // Transport errors retain their classification from retry.js.
    const transportResponse = mapTransportError(error);

    if (transportResponse) {
      return res
        .status(transportResponse.status)
        .json(transportResponse.body);
    }

    // Unexpected application error.
    return res.status(500).json({
      error: "internal_error",
      message: "The maintenance triage request could not be completed.",
    });
  }
});

export default router;
