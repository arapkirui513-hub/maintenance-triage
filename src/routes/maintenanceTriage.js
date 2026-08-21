import { Router } from "express";
import { InputSchema, ModelOutputSchema } from "../llm/schema.js";
import { classifyMaintenanceReport } from "../llm/client.js";
import { applyConfidencePolicy } from "../llm/policy.js";

const router = Router();

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

  const { text } = inputResult.data;

  // 2. Call the model (or the stub). Returns raw text, not yet parsed.
  let rawText;
  try {
    rawText = await classifyMaintenanceReport(text);
  } catch (err) {
    // Stage 4 will replace this with timeout/retry-aware handling.
    return res.status(500).json({
      error: "model_call_failed",
      message: err.message,
    });
  }

  // 3. Parse the raw text as JSON. Models sometimes wrap output in prose or
  //    a code fence; classifyMaintenanceReport() already strips fences, but
  //    a malformed response can still fail to parse here. Stage 3 will route
  //    a parse failure into the repair retry instead of a flat 422.
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return res.status(422).json({
      error: "unparseable_model_output",
      message: "Model output was not valid JSON.",
    });
  }

  // 4. Validate the parsed output against the schema.
  //    Stage 3 will add the repair retry and quarantine logging here.
  const outputResult = ModelOutputSchema.safeParse(parsed);
  if (!outputResult.success) {
    return res.status(422).json({
      error: "invalid_model_output",
      message: "Model output failed schema validation.",
    });
  }

  // 5. Apply the deterministic confidence policy (application logic, not model logic).
  const finalResult = applyConfidencePolicy(outputResult.data);

  return res.status(200).json(finalResult);
});

export default router;
