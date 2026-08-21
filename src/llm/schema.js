import { z } from "zod";

// Closed lists, locked in JOB-CARD.md. Any value outside these is a validation
// failure, not a new category, and triggers the repair-retry / quarantine path.

export const EQUIPMENT_TYPES = [
  "ventilator",
  "infusion_pump",
  "patient_monitor",
  "defibrillator",
  "dialysis_machine",
  "anesthesia_machine",
  "imaging_equipment",
  "sterilizer",
  "other",
];

export const ISSUE_TYPES = [
  "malfunction",
  "calibration",
  "alarm_fault",
  "physical_damage",
  "connectivity",
  "power_supply",
  "consumable_supply",
  "unknown",
];

export const URGENCY_LEVELS = ["low", "normal", "high", "critical"];

export const ASSIGNED_TEAMS = [
  "biomedical_engineering",
  "ict_support",
  "facilities",
  "nursing_supply_chain",
  "vendor_escalation",
];

// What the model itself must return. No "other" fallback on assigned_team here
// deliberately: the model always names its best-guess team; the low-confidence
// override to biomedical_engineering is an application-layer decision, applied
// after validation, not something we ask the model to decide.
export const ModelOutputSchema = z.object({
  equipment_type: z.enum(EQUIPMENT_TYPES),
  issue_type: z.enum(ISSUE_TYPES),
  urgency: z.enum(URGENCY_LEVELS),
  assigned_team: z.enum(ASSIGNED_TEAMS),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300),
}).strict();

// Input validation, checked before any model call is made.
export const InputSchema = z.object({
  text: z.string().min(1).max(2000),
});
