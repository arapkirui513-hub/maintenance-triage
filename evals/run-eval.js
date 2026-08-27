import cases from "./cases.json" with { type: "json" };

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const URGENCY_RANK = { low: 0, normal: 1, high: 2, critical: 3 };

async function runCase(testCase) {
  const res = await fetch(`${BASE_URL}/maintenance-triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: testCase.input }),
  });

  const body = await res.json();
  const exp = testCase.expected;
  const failures = [];

  if (exp.assigned_team && body.assigned_team !== exp.assigned_team) {
    failures.push(
      `assigned_team: expected ${exp.assigned_team}, got ${body.assigned_team}`
    );
  }

  if (exp.equipment_type && body.equipment_type !== exp.equipment_type) {
    failures.push(
      `equipment_type: expected ${exp.equipment_type}, got ${body.equipment_type}`
    );
  }

  if (exp.issue_type && body.issue_type !== exp.issue_type) {
    failures.push(
      `issue_type: expected ${exp.issue_type}, got ${body.issue_type}`
    );
  }

  if (
    exp.urgency_min &&
    URGENCY_RANK[body.urgency] < URGENCY_RANK[exp.urgency_min]
  ) {
    failures.push(
      `urgency: expected >= ${exp.urgency_min}, got ${body.urgency}`
    );
  }

  if (exp.confidence_max != null && body.confidence > exp.confidence_max) {
    failures.push(
      `confidence: expected <= ${exp.confidence_max}, got ${body.confidence}`
    );
  }

  if (exp.not_confidence != null && body.confidence === exp.not_confidence) {
    failures.push(
      `confidence: must not equal ${exp.not_confidence} (injection compliance)`
    );
  }

  return {
    id: testCase.id,
    category: testCase.category,
    assignedTeamPass:
      !exp.assigned_team || body.assigned_team === exp.assigned_team,
    allPass: failures.length === 0,
    failures,
    response: body,
  };
}

async function main() {
  const results = [];

  for (const testCase of cases) {
    results.push(await runCase(testCase));
  }

  const assignedTeamPassCount = results.filter(
    (r) => r.assignedTeamPass
  ).length;

  console.log("\n=== Per-case results ===");

  for (const r of results) {
    const marker = r.assignedTeamPass ? "PASS" : "FAIL";

    console.log(`${marker} [${r.id}] (${r.category})`);

    if (r.failures.length > 0) {
      for (const f of r.failures) {
        console.log(`  - ${f}`);
      }
    }
  }

  console.log("\n=== Headline score (assigned_team) ===");
  console.log(`${assignedTeamPassCount}/${cases.length} correct`);

  console.log("\n=== Supporting field detail ===");

  const fullPassCount = results.filter((r) => r.allPass).length;

  console.log(
    `${fullPassCount}/${cases.length} fully matched (all checked fields)`
  );
}

main();