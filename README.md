# maintenance-triage

`POST /maintenance-triage` takes a messy biomedical equipment maintenance
report and returns a validated, closed-list classification that application
code can route on:

- equipment type
- issue type
- urgency
- assigned team
- confidence
- short reason

The system does not diagnose patients, recommend treatment, or make clinical
judgements. Urgency refers only to equipment and workflow impact.

See `JOB-CARD.md` for the full locked contract.

## Status

**Stages 0-3 complete.**

Completed:

- Stage 0: job card, provider configuration, environment protection
- Stage 1: endpoint, input validation, output schema, deterministic policy,
  and stub mode
- Stage 2: versioned prompt and OpenRouter model call
- Stage 3: strict output validation, one repair attempt, and quarantine logging

Not yet complete:

- Stage 4: transport retries, timeout/error handling, outer deadline,
  cost logging, and kill switch
- Stage 5: eight-case evaluation and final evaluation score
- Stage 6: final README evidence and submission packaging

---

## Setup

```bash
npm install
cp .env.example .env