// Tests for the 100-slot generation system: pure logic, D1 store semantics and
// the slot-based runner flow. The store is exercised against an in-memory fake
// that implements the same SQL surface the D1 binding exposes.
import { describe, expect, it } from "vitest";
import { batches, canTransition, checkRequestSize, pickFreePromptSlots, repairAllowed, slotTypeFor, SLOT_LIMITS } from "@/lib/sandbox/slots";
import { runSlotJob, validatePrompt } from "@/lib/sandbox/slot-runner.server";
import * as store from "@/lib/sandbox/slots.server";

// Minimal in-memory stand-in for the D1 slot tables, honoring the same
// conditional-UPDATE semantics (status guards, ownership filters).
function fakeDb() {
  const slots = new Map<number, any>();
  const records = new Map<string, any>();
  const db = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    if (sql.startsWith("CREATE TABLE")) return [];
    if (sql.startsWith("INSERT OR IGNORE INTO generation_slots")) {
      const [id, type] = params as [number, string];
      if (!slots.has(id)) slots.set(id, { slot_id: id, slot_type: type, user_id: null, job_id: null, prompt_index: null, status: "free", result: null, result_ref: null, blueprint_ref: null, story_ref: null, findings: null, repair_attempts: 0, error_code: null, created_at: null, updated_at: null });
      return [];
    }
    if (sql.startsWith("INSERT INTO generation_records")) {
      const [id, user_id, job_id, slot_id, kind, content, checksum, created_at] = params as any[];
      records.set(id, { id, user_id, job_id, slot_id, kind, content, checksum, created_at });
      return [];
    }
    if (sql.startsWith("SELECT content, checksum FROM generation_records")) {
      const [id, user_id] = params as [string, string];
      const r = records.get(id);
      return r && r.user_id === user_id ? [{ content: r.content, checksum: r.checksum }] : [];
    }
    if (sql.includes("FROM generation_slots WHERE user_id = ? AND job_id = ? AND slot_type = 'prompt'")) {
      const [user_id, job_id] = params as [string, string];
      return [...slots.values()].filter((s) => s.user_id === user_id && s.job_id === job_id && s.slot_type === "prompt");
    }
    if (sql.startsWith("SELECT * FROM generation_slots WHERE user_id = ? AND job_id = ? ORDER BY slot_id")) {
      const [user_id, job_id] = params as [string, string];
      return [...slots.values()].filter((s) => s.user_id === user_id && s.job_id === job_id).sort((a, b) => a.slot_id - b.slot_id);
    }
    if (sql.startsWith("SELECT slot_id, slot_type, status FROM generation_slots ORDER BY slot_id")) {
      return [...slots.values()].map((s) => ({ slot_id: s.slot_id, slot_type: s.slot_type, status: s.status })).sort((a, b) => a.slot_id - b.slot_id);
    }
    if (sql.startsWith("SELECT * FROM generation_slots WHERE slot_id = ?")) {
      const [slot_id, user_id, job_id] = params as [number, string, string];
      const s = slots.get(slot_id);
      return s && s.user_id === user_id && s.job_id === job_id ? [s] : [];
    }
    if (sql.startsWith("UPDATE generation_slots SET user_id = ?, job_id = ?, status = 'claimed'")) {
      const [user_id, job_id, , slot_id, ou, oj] = params as any[];
      const s = slots.get(slot_id);
      if (s && (s.status === "free" || (s.user_id === ou && s.job_id === oj))) {
        Object.assign(s, { user_id, job_id, status: "claimed", updated_at: Date.now() });
        return [{ slot_id }];
      }
      return [];
    }
    if (sql.startsWith("UPDATE generation_slots SET user_id = ?, job_id = ?, prompt_index = ?")) {
      const [user_id, job_id, prompt_index, , slot_id] = params as any[];
      const s = slots.get(slot_id);
      if (s && s.status === "free") {
        Object.assign(s, { user_id, job_id, prompt_index, status: "claimed", repair_attempts: 0, findings: null, error_code: null, updated_at: Date.now() });
        return [{ slot_id }];
      }
      return [];
    }
    if (sql.startsWith("UPDATE generation_slots SET status = ?")) {
      const to = params[0] as string;
      const slot_id = params[params.length - 3] as number;
      const user_id = params[params.length - 2] as string;
      const from = params[params.length - 1] as string;
      const s = slots.get(slot_id);
      if (!s || s.user_id !== user_id || s.status !== from) return [];
      s.status = to;
      s.updated_at = Date.now();
      if (to === "repaired_unverified") s.repair_attempts += 1;
      // apply patch params in SET order: status, updated_at, then patched keys
      const keys = ["result", "result_ref", "findings", "error_code", "blueprint_ref", "story_ref"];
      const patchValues = params.slice(2, params.length - 3);
      const setMatch = sql.match(/SET (.+) WHERE/)![1].split(",").map((p) => p.trim());
      const setKeys = setMatch.slice(2).map((p) => p.split(" ")[0]);
      setKeys.forEach((k, i) => { if (keys.includes(k)) s[k] = patchValues[i]; });
      return [{ slot_id }];
    }
    if (sql.includes("SET status = 'free', user_id = NULL")) {
      const [, user_id, job_id] = params as any[];
      const mine = [...slots.values()].filter((s) => s.user_id === user_id && s.job_id === job_id);
      for (const s of mine) Object.assign(s, { status: "free", user_id: null, job_id: null, prompt_index: null, result: null, result_ref: null, blueprint_ref: null, story_ref: null, findings: null, repair_attempts: 0, error_code: null });
      return mine.map((s) => ({ slot_id: s.slot_id }));
    }
    throw new Error(`fakeDb: unhandled SQL: ${sql.slice(0, 80)}`);
  };
  return { db, slots, records };
}

const okCall = (text: string) => async () => ({ ok: true as const, text, finishReason: "stop", model: { provider: "nvidia" as const, model: "m", label: "m" } });
const PROMPT_TEXT = "A prompt body that is comfortably longer than forty characters.";

describe("slot pure logic", () => {
  it("assigns slot types: 1 blueprint, 2 story, 3-100 prompt", () => {
    expect(slotTypeFor(1)).toBe("blueprint");
    expect(slotTypeFor(2)).toBe("story");
    expect(slotTypeFor(3)).toBe("prompt");
    expect(slotTypeFor(100)).toBe("prompt");
  });
  it("caps a request at 25 prompts", () => {
    expect(checkRequestSize(25).ok).toBe(true);
    expect(checkRequestSize(26)).toEqual({ ok: false, reason: expect.stringContaining("25") });
    expect(checkRequestSize(0).ok).toBe(false);
  });
  it("splits into batches of 10", () => {
    expect(batches(25).map((b) => b.length)).toEqual([10, 10, 5]);
    expect(batches(3)).toEqual([[0, 1, 2]]);
  });
  it("allows exactly one repair attempt", () => {
    expect(repairAllowed({ status: "failed", repair_attempts: 0 })).toBe(true);
    expect(repairAllowed({ status: "failed", repair_attempts: SLOT_LIMITS.maxRepairAttempts })).toBe(false);
    expect(repairAllowed({ status: "validated", repair_attempts: 0 })).toBe(false);
  });
  it("rejects illegal status transitions", () => {
    expect(canTransition("free", "claimed")).toBe(true);
    expect(canTransition("free", "validated")).toBe(false);
    expect(canTransition("validated", "generating")).toBe(false);
    expect(canTransition("failed", "claimed")).toBe(true);
  });
  it("picks lowest free prompt slots first", () => {
    const snap = [
      { slot_id: 5, slot_type: "prompt" as const, status: "free" as const },
      { slot_id: 3, slot_type: "prompt" as const, status: "free" as const },
      { slot_id: 4, slot_type: "prompt" as const, status: "claimed" as const },
      { slot_id: 1, slot_type: "blueprint" as const, status: "free" as const },
    ];
    expect(pickFreePromptSlots(snap, 2)).toEqual([3, 5]);
  });
});

describe("slot store (in-memory D1 semantics)", () => {
  it("seeds all 100 slots idempotently", async () => {
    const { db, slots } = fakeDb();
    await store.ensureSlots(db as any);
    await store.ensureSlots(db as any);
    expect(slots.size).toBe(100);
    expect(slots.get(1).slot_type).toBe("blueprint");
    expect(slots.get(2).slot_type).toBe("story");
  });
  it("claims fixed slots once; a second job cannot take them", async () => {
    const { db } = fakeDb();
    expect(await store.claimFixedSlot("u1", "j1", 1, db as any)).toBe(true);
    expect(await store.claimFixedSlot("u2", "j2", 1, db as any)).toBe(false);
    expect(await store.claimFixedSlot("u1", "j1", 1, db as any)).toBe(true); // same job re-claim is fine
  });
  it("claims prompt slots without collision and enforces capacity", async () => {
    const { db } = fakeDb();
    const a = await store.claimPromptSlots("u1", "j1", 25, db as any);
    expect(a).toHaveLength(25);
    const b = await store.claimPromptSlots("u2", "j2", 25, db as any);
    expect(b).toHaveLength(25);
    expect(a.some((s) => b.includes(s))).toBe(false);
  });
  it("rejects illegal transitions and foreign owners", async () => {
    const { db } = fakeDb();
    await store.claimFixedSlot("u1", "j1", 1, db as any);
    expect(await store.setSlotStatus("u1", "j1", 1, "validated", {}, db as any)).toBe(false); // claimed -> validated illegal
    expect(await store.setSlotStatus("u2", "j1", 1, "generating", {}, db as any)).toBe(false); // wrong owner
    expect(await store.setSlotStatus("u1", "j1", 1, "generating", {}, db as any)).toBe(true);
  });
  it("releases job slots for reuse", async () => {
    const { db } = fakeDb();
    await store.claimPromptSlots("u1", "j1", 5, db as any);
    expect(await store.releaseJobSlots("u1", "j1", db as any)).toBe(5);
    const again = await store.claimPromptSlots("u2", "j2", 5, db as any);
    expect(again).toHaveLength(5);
  });
});

describe("slot runner flow", () => {
  it("runs blueprint → story → prompts, marking all validated", async () => {
    const { db } = fakeDb();
    const res = await runSlotJob("u1", "job-a", { instructions: "A forest tale.", count: 3 }, { db: db as any, call: okCall(PROMPT_TEXT) });
    expect(res).toEqual({ status: "completed", validated: 3, repaired: 0, failed: 0 });
  });
  it("marks repaired prompts repaired_unverified after one repair, never re-validated", async () => {
    const { db, slots } = fakeDb();
    let n = 0;
    const call = async () => {
      n++;
      // blueprint, story ok; prompt 1 too short, then repaired
      const text = n === 3 ? "short" : PROMPT_TEXT;
      return { ok: true as const, text, finishReason: "stop", model: { provider: "nvidia" as const, model: "m", label: "m" } };
    };
    const res = await runSlotJob("u1", "job-b", { instructions: "x", count: 1 }, { db: db as any, call });
    expect(res).toEqual({ status: "completed", validated: 0, repaired: 1, failed: 0 });
    const promptSlot = [...slots.values()].find((s) => s.slot_type === "prompt" && s.job_id === "job-b");
    expect(promptSlot.status).toBe("repaired_unverified");
    expect(promptSlot.repair_attempts).toBe(1);
    expect(JSON.parse(promptSlot.findings)).toContain("too_short");
  });
  it("resumes without regenerating validated slots", async () => {
    const { db } = fakeDb();
    let calls = 0;
    const call = async () => { calls++; return { ok: true as const, text: PROMPT_TEXT, finishReason: "stop", model: { provider: "nvidia" as const, model: "m", label: "m" } }; };
    await runSlotJob("u1", "job-c", { instructions: "x", count: 2 }, { db: db as any, call });
    const afterFirst = calls;
    const res = await runSlotJob("u1", "job-c", { instructions: "x", count: 2 }, { db: db as any, call });
    expect(res.validated).toBe(2);
    expect(calls).toBe(afterFirst); // no duplicate provider calls on resume
  });
  it("rejects requests above 25 prompts", async () => {
    const { db } = fakeDb();
    const res = await runSlotJob("u1", "job-d", { instructions: "x", count: 26 }, { db: db as any, call: okCall(PROMPT_TEXT) });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("25");
  });
  it("continues other prompts when one fails", async () => {
    const { db } = fakeDb();
    let n = 0;
    const call = async () => {
      n++;
      if (n === 3) return { ok: false as const, status: 503, reason: "down" }; // first prompt fails
      return { ok: true as const, text: PROMPT_TEXT, finishReason: "stop", model: { provider: "nvidia" as const, model: "m", label: "m" } };
    };
    const res = await runSlotJob("u1", "job-e", { instructions: "x", count: 2 }, { db: db as any, call });
    expect(res.status).toBe("completed");
    expect(res.validated).toBe(1);
    expect(res.failed).toBe(1);
  });
});

describe("prompt validation", () => {
  it("flags empty and too-short prompts", () => {
    expect(validatePrompt("").ok).toBe(false);
    expect(validatePrompt("tiny").findings).toContain("too_short");
    expect(validatePrompt(PROMPT_TEXT).ok).toBe(true);
  });
});
