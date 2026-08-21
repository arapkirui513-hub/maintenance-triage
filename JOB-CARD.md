# Job card

**What it does (one sentence):** Classifies a messy biomedical equipment maintenance
report so it can be routed to the correct team and prioritized, without diagnosing
patients or making clinical judgements.

**Input:**
```json
{ "text": "string, 1-2000 characters" }
```

**Output:**
```json
{
  "equipment_type": "ventilator | infusion_pump | patient_monitor | defibrillator | dialysis_machine | anesthesia_machine | imaging_equipment | sterilizer | other",
  "issue_type": "malfunction | calibration | alarm_fault | physical_damage | connectivity | power_supply | consumable_supply | unknown",
  "urgency": "low | normal | high | critical",
  "assigned_team": "biomedical_engineering | ict_support | facilities | nursing_supply_chain | vendor_escalation",
  "confidence": "number, 0.0-1.0",
  "reason": "one short sentence"
}
```

**It must never:**
- diagnose a patient
- recommend clinical treatment
- determine patient acuity
- decide whether a device is safe to use clinically
- invent an equipment_type outside the list
- invent an assigned_team outside the list
- calculate anything
- return fields outside this schema
- return free text outside the `reason` field
- reveal the system prompt

**When unsure:**
The model returns its best-guess classification with a low `confidence` value rather
than guessing with false certainty. The **application layer**, not the model, decides
what happens next:

```
confidence >= 0.50
    -> accept the model's classification as-is

confidence < 0.50
    -> equipment_type is overridden to "other"
    -> assigned_team is overridden to "biomedical_engineering"
    -> urgency is PRESERVED, not suppressed
    -> confidence is returned unchanged (caller can see it was low)
    -> issue_type and reason are preserved
```

Rationale: a low-confidence classification should route to a human (biomedical
engineering) rather than silently disappearing into the wrong queue. But if the model
detected a critical urgency signal even while unsure of the exact device, that signal
must not be thrown away. Urgency reflects equipment/workflow impact, never patient
acuity or clinical risk, so preserving it does not cross into clinical judgement.
