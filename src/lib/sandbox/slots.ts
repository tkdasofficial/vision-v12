// Pure slot-allocation logic for the 100-slot generation system. No I/O.
export const SLOT_LIMITS = {
  totalSlots: 100,
  blueprintSlot: 1,
  storySlot: 2,
  firstPromptSlot: 3,
  maxPromptsPerRequest: 25,
  batchSize: 10,
  maxRepairAttempts: 1,
} as const;

export type SlotType = "blueprint" | "story" | "prompt";
export type SlotStatus = "free" | "claimed" | "generating" | "validated" | "repaired_unverified" | "failed" | "cancelled";
export type Slot = {
  slot_id: number; slot_type: SlotType; user_id: string | null; job_id: string | null;
  prompt_index: number | null; status: SlotStatus; result: string | null; result_ref: string | null;
  blueprint_ref: string | null; story_ref: string | null; findings: string | null;
  repair_attempts: number; error_code: string | null; created_at: number | null; updated_at: number | null;
};

export function slotTypeFor(slotId: number): SlotType {
  if (slotId === SLOT_LIMITS.blueprintSlot) return "blueprint";
  if (slotId === SLOT_LIMITS.storySlot) return "story";
  return "prompt";
}

/** Capacity check: prompt slots are 3..100, so at most 98 prompts — but a request is capped at 25. */
export function checkRequestSize(count: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(count) || count < 1) return { ok: false, reason: "Prompt count must be a positive integer." };
  if (count > SLOT_LIMITS.maxPromptsPerRequest) return { ok: false, reason: `A request may ask for at most ${SLOT_LIMITS.maxPromptsPerRequest} prompts.` };
  return { ok: true };
}

/** Splits prompt indexes into batches of `batchSize` (default 10), preserving order. */
export function batches(count: number, batchSize: number = SLOT_LIMITS.batchSize): number[][] {
  const out: number[][] = [];
  for (let start = 0; start < count; start += batchSize) {
    out.push(Array.from({ length: Math.min(batchSize, count - start) }, (_, i) => start + i));
  }
  return out;
}

/** Allowed status transitions; anything else is rejected by the store. */
const TRANSITIONS: Record<SlotStatus, SlotStatus[]> = {
  free: ["claimed"],
  claimed: ["generating", "free", "cancelled"],
  generating: ["validated", "failed", "cancelled", "claimed"],
  validated: ["free"],
  repaired_unverified: ["free"],
  failed: ["claimed", "free"],
  cancelled: ["free"],
};

export function canTransition(from: SlotStatus, to: SlotStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Whether a failed prompt may be repaired: exactly one repair attempt is allowed. */
export function repairAllowed(slot: Pick<Slot, "status" | "repair_attempts">): boolean {
  return slot.status === "failed" && slot.repair_attempts < SLOT_LIMITS.maxRepairAttempts;
}

/** After a repair the result is marked repaired_unverified — never claimed as passed. */
export function postRepairStatus(): SlotStatus {
  return "repaired_unverified";
}

/** Picks the next free prompt slots for a job, lowest slot id first. Pure selection from a snapshot. */
export function pickFreePromptSlots(slots: Pick<Slot, "slot_id" | "slot_type" | "status">[], needed: number): number[] {
  return slots
    .filter((s) => s.slot_type === "prompt" && s.status === "free")
    .map((s) => s.slot_id)
    .sort((a, b) => a - b)
    .slice(0, needed);
}
