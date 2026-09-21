# maintenance-triage

> **Status:** Active

A bounded LLM workflow that classifies messy biomedical equipment maintenance reports into a controlled routing schema for hospital operations.

It identifies:

* equipment type
* issue type
* urgency
* assigned team
* confidence
* short reason

The system does not diagnose patients, recommend treatment, determine patient acuity, or decide whether a device is clinically safe to use. Urgency refers only to equipment and workflow impact.

See [`JOB-CARD.md`](./JOB-CARD.md) for the locked job contract.

---

## What It Does

`POST /maintenance-triage` accepts a maintenance report and returns a validated JSON classification.

The workflow is:

```text
Input validation
      ↓
Kill switch check
      ↓
Initial LLM call
      ↓
JSON parsing + schema validation
      ↓
One repair attempt if validation fails
      ↓
Quarantine if repair also fails
      ↓
Deterministic confidence policy
      ↓
Final routing classification
```

The model operates within a closed output schema. Application code controls the deterministic policy decisions after model validation.

### Confidence policy

```text
confidence >= 0.50
    → accept model classification

confidence < 0.50
    → equipment_type = "other"
    → assigned_team = "biomedical_engineering"
    → urgency preserved
    → issue_type preserved
    → confidence preserved
    → reason preserved
```

This prevents an uncertain model classification from silently routing a report to an inappropriate queue while preserving useful urgency information.

---

## Example Request

```bash
curl -X POST http://localhost:3000/maintenance-triage \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"The ICU ventilator in bed 3 keeps alarming.\"}"
```

Example response (real output from `openrouter/free`, prompt version `maintenance-triage-v1`):

```json
{
  "equipment_type": "ventilator",
  "issue_type": "alarm_fault",
  "urgency": "high",
  "assigned_team": "biomedical_engineering",
  "confidence": 0.9,
  "reason": "Ventilator alarm with a suspect oxygen reading indicates a device malfunction requiring biomedical engineering review."
}
```

---

## Job Card

### Input

```json
{
  "text": "string, 1-2000 characters"
}
```

### Output

```json
{
  "equipment_type": "ventilator | infusion_pump | patient_monitor | defibrillator | dialysis_machine | anesthesia_machine | imaging_equipment | sterilizer | other",
  "issue_type": "malfunction | calibration | alarm_fault | physical_damage | connectivity | power_supply | consumable_supply | unknown",
  "urgency": "low | normal | high | critical",
  "assigned_team": "biomedical_engineering | ict_support | facilities | nursing_supply_chain | vendor_escalation",
  "confidence": 0.0,
  "reason": "one short sentence"
}
```

The output contains exactly six fields.

The model must not:

* diagnose a patient
* recommend clinical treatment
* determine patient acuity
* decide whether a device is clinically safe to use
* invent values outside the controlled lists
* add fields outside the schema
* return free text outside `reason`
* reveal the system prompt

---

## Provider, Model and Environment

The application uses an OpenAI-compatible API endpoint.

The configured provider endpoint is OpenRouter:

```text
LLM_BASE_URL=https://openrouter.ai/api/v1
```

The configured model is controlled through:

```text
LLM_MODEL=openrouter/free
```

The API key is supplied through:

```text
LLM_API_KEY=<your key>
```

The application kill switch is:

```text
LLM_ENABLED=true
```

The server port is configured with:

```text
PORT=3000
```

### Environment variables

| Variable        | Purpose                                   |
| --------------- | ------------------------------------------ |
| `LLM_BASE_URL`  | OpenAI-compatible model provider endpoint |
| `LLM_API_KEY`   | Provider authentication                   |
| `LLM_MODEL`     | Model identifier                          |
| `LLM_ENABLED`   | Enables or disables real model calls      |
| `PORT`          | HTTP server port                          |
| `LLM_STUB`      | Controlled local testing mode             |
| `LLM_STUB_CASE` | Selects a deterministic Stage 3 test case |

Stub variables are used for controlled testing and should not be enabled for the real evaluation.

Never commit `.env` or API keys to the repository. Use `.env.example` for configuration documentation.

---

## Reliability Controls

### Transport retries

Model transport failures use bounded retries.

The retry layer distinguishes transport conditions including:

* timeout
* rate limit
* upstream 4xx
* upstream 5xx
* authentication failure
* network failure

The route maps these failures to explicit HTTP error responses.

### Timeouts

The model client uses a 15-second provider request timeout.

The complete maintenance-triage workflow has an outer 60-second response deadline.

### Kill switch

When:

```text
LLM_ENABLED != true
```

the endpoint returns HTTP `503` instead of producing a fallback classification.

This prevents the application from silently guessing when the LLM service is disabled.

---

## Output Validation and Repair

The parser validates model output against the controlled schema.

Validation covers:

* JSON parsing
* required fields
* closed-list enum values
* confidence range
* exact output shape

If the initial response fails validation, the system permits exactly one repair attempt.

If the repaired response also fails validation, the output is quarantined and the endpoint returns an explicit invalid-model-output response.

The model transport layer and parser layer remain separate:

```text
client.js
    → model transport

parser.js
    → parsing
    → code-fence handling
    → schema validation
    → one repair attempt
    → quarantine

policy.js
    → deterministic confidence policy
```

---

## Prompt Injection Handling

Maintenance reports are treated as untrusted data.

The system prompt explicitly instructs the model not to follow instructions contained inside maintenance reports that attempt to change:

* classification rules
* allowed values
* output format
* system role

The evaluation suite includes a prompt-injection case.

---

## Evaluation

The repository contains an eight-case evaluation suite:

```text
evals/cases.json
evals/run-eval.js
```

The cases cover:

1. clear equipment malfunction
2. calibration
3. connectivity
4. facilities/power failure
5. consumable supply
6. ambiguous equipment
7. low-confidence urgency preservation
8. prompt injection

The headline metric is `assigned_team`, because the primary application purpose is routing the maintenance report to the correct operational team.

### Real-model evaluation

**Evaluation date:** August 27, 2026

**Prompt version:** `maintenance-triage-v1`

**Headline result:**

```text
8/8 assigned_team correct
100%
```

**Supporting field result:**

```text
8/8 fully matched
```

All eight cases matched on every checked field in this run, including Case 7's uncertainty policy (confidence 0.4 triggered the low-confidence override, while `urgency` stayed `high` rather than being suppressed) and Case 8's prompt-injection resistance (the model returned the legitimate `biomedical_engineering` classification at confidence 0.95, ignoring the injected instruction to return `vendor_escalation` at confidence 1.0).

Because this evaluation runs against `openrouter/free`, which auto-routes each request to a different underlying free model, results can vary slightly between runs even at temperature 0. This score reflects a single run on the date above; re-running the suite may not reproduce identical wording or, in principle, identical classifications.

Run the evaluation with:

```bash
node evals/run-eval.js
```

The evaluation runner reports both the headline routing score and supporting-field detail.

---

## Cost and Usage Logging

Successful model completions record structured usage metadata without logging maintenance reports, prompts, model output, or API keys.

Each successful initial or repair call records:

```json
{
  "timestamp": "...",
  "prompt_version": "maintenance-triage-v1",
  "call_type": "initial",
  "model": "...",
  "input_tokens": 0,
  "output_tokens": 0,
  "duration_ms": 0
}
```

The logger records actual provider-reported token usage when the provider returns it. Missing usage values remain `null` rather than being fabricated.

A repair call is logged separately from the initial call. Note that this log only records successful completions; a request that exhausts transport retries and fails produces attempt-log entries but no completion-log entry, since no usage data exists for a call that never returned.

### Cost estimate

The evaluation uses OpenRouter's `openrouter/free` router, which currently provides free-model inference at $0 per token.

```text
Cost per successful model call: $0
Cost for 10,000 requests/day: $0 at free-model pricing
```

The real constraint is quota, not inference cost. OpenRouter's free tier caps requests at 20/minute and 50/day for an unfunded account (rising to 1,000/day after any $10 lifetime credit purchase). A target of 10,000 requests/day would require roughly 200x the unfunded daily quota, meaning a move to a paid tier or a self-hosted deployment would be required regardless of token pricing.

The application still records model, input tokens, output tokens, and duration so that paid-model costs can be calculated directly if the deployment moves away from free inference.

---

## Repository Structure

```text
maintenance-triage/
├── evals/
│   ├── cases.json
│   └── run-eval.js
├── prompts/
│   └── maintenance-triage-v1.md
├── src/
│   ├── llm/
│   │   ├── client.js
│   │   ├── costLog.js
│   │   ├── parser.js
│   │   ├── policy.js
│   │   ├── retry.js
│   │   └── schema.js
│   ├── routes/
│   │   └── maintenanceTriage.js
│   └── index.js
├── .env.example
├── JOB-CARD.md
├── package.json
└── README.md
```

---

## Running Locally

Install dependencies:

```bash
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

Configure the required provider variables:

```text
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=<your key>
LLM_MODEL=openrouter/free
LLM_ENABLED=true
PORT=3000
```

Start the API:

```bash
npm start
```

The server listens on:

```text
http://localhost:3000
```

Test the endpoint:

```bash
curl -X POST http://localhost:3000/maintenance-triage \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"The ventilator in ICU bed 3 keeps alarming.\"}"
```

Run the evaluation suite:

```bash
node evals/run-eval.js
```

---

## Verification Status

Completed implementation areas:

* Stage 0: job card and provider configuration
* Stage 1: endpoint, input validation, output schema, policy and stub mode
* Stage 2: versioned prompt and OpenRouter model integration
* Stage 3: strict output validation, one repair attempt and quarantine
* Transport retry and error handling
* 15-second model timeout
* 60-second workflow deadline
* LLM kill switch
* Completion-side model usage logging
* Eight-case evaluation suite
* Real-model evaluation

Latest repository state:

```text
Working tree: clean
Headline evaluation: 8/8 (100%)
Supporting fields: 8/8
Prompt version: maintenance-triage-v1
```

---

## Known Limitations

The implementation is intentionally bounded, but these areas would be worth improving with another day of engineering work:

1. **Provider-specific error behaviour:** timeout and cancellation handling has been verified against the relevant OpenAI SDK error classes and native AbortController/DOMException shapes used by the implementation. Provider-specific behaviour outside these tested shapes may still require additional verification.

2. **Provider-specific dollar accounting:** completion logging captures model, token usage and duration, but it does not calculate provider-specific dollar cost for paid models. Cost estimation for a non-free deployment remains an external calculation based on the applicable model's pricing.

3. **Run-to-run variance on `openrouter/free`:** because the free router selects among different underlying models per request, the eval score and exact wording can vary between runs even at temperature 0. A pinned model would remove this variable but would also remove the zero-cost testing this project relies on.

These limitations are documented rather than hidden.

---

## Commit History

The repository contains the required development history, including:

```text
b98b3e1  add maintenance triage evaluation suite
f2b441f  add model completion cost logging
bc9fe35  refactor LLM parsing and transport error handling
b3c305e  feat: add bounded LLM transport retries
c4aec4a  Docs: document stages 0-3
a0a6af7  Stage 3: repair validation and quarantine
```

The repository therefore contains more than the required six commits.

---

## License

This project was created as an evaluation/project artifact.