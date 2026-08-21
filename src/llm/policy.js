const CONFIDENCE_THRESHOLD = 0.5;

/**
 * Applies the deterministic uncertainty policy from JOB-CARD.md.
 * This runs AFTER schema validation, on a value already known to be
 * schema-valid. It never talks to the model.
 *
 * @param {object} validated - a ModelOutputSchema-shaped object
 * @returns {object} the same shape, with policy applied
 */
export function applyConfidencePolicy(validated) {
  if (validated.confidence >= CONFIDENCE_THRESHOLD) {
    return validated;
  }

  return {
    ...validated,
    equipment_type: "other",
    assigned_team: "biomedical_engineering",
    // urgency, issue_type, reason, and confidence are preserved on purpose.
    // See JOB-CARD.md "When unsure" for the reasoning.
  };
}

export { CONFIDENCE_THRESHOLD };
