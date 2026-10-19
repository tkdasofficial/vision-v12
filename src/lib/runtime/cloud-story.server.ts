// Cloudflare-native story/prompt generation: runs entirely on this Worker using the
// vision-sandbox D1 slot store (slot 1 blueprint, slot 2 story, slots 3-100 scenes).
// No GitHub Actions involvement. Delivery reuses the existing runtime_jobs finalizer:
// the assembled document is stored as private artifact chunks and the job is marked
// "uploaded", so syncRuntimeJob/finalize validate it and deliver it to the chat.
import { d1 } from "@/lib/cloud/d1.server";
import { JobRun, safeError } from "@/lib/jobs/jobs.server";
import { orchestrateText, type Completion } from "../ai/orchestrator.server";
import { TEXT_CHAIN } from "../ai/models.server";
import * as slots from "../sandbox/slots.server";
import { SLOT_LIMITS } from "../sandbox/slots";
import { parseSceneCount, sceneContract, validateScene, assembleStoryDocument, validateAssembled, STORY_LIMITS } from "./cloud-story";

const now = () => new Date().toISOString();

type Call = (messages: unknown[], maxTokens: number) => Promise<Completion>;
const defaultCall: Call = (messages, maxTokens) =>
  orchestrateText(messages, { maxTokens, deep: false, signal: new AbortController().signal, taskId: "cloud-story", models: TEXT_CHAIN });

async function sha256Hex(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function setStage(jobId: string, stage: string) {
  await d1("UPDATE runtime_jobs SET stage = ?, updated_at = ? WHERE job_id = ?", [stage, now(), jobId]);
}

async function cancelRequested(jobId: string): Promise<boolean> {
  const r = await d1<{ cancel_requested: number }>("SELECT cancel_requested FROM jobs WHERE id = ?", [jobId]);
  return !!r[0]?.cancel_requested;
}

async function fail(jobId: string, message: string): Promise<void> {
  await d1("UPDATE runtime_jobs SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ? AND status IN ('queued','dispatched','running')", [message.slice(0, 400), now(), jobId]);
}

/** Generates content into a claimed slot and stores it as a generation record. */
async function generateIntoSlot(
  userId: string, jobId: string, slotId: number, kind: "blueprint" | "story" | "prompt",
  messages: unknown[], maxTokens: number, call: Call,
): Promise<{ ok: boolean; recordId?: string; content?: string; error?: string }> {
  const claimed = await slots.setSlotStatus(userId, jobId, slotId, "generating", {});
  if (!claimed) return { ok: false, error: "slot_unavailable" };
  const res = await call(messages, maxTokens);
  if (!res.ok || !res.text.trim()) {
    await slots.setSlotStatus(userId, jobId, slotId, "failed", { error_code: res.ok ? "empty" : `provider_${res.status}` });
    return { ok: false, error: res.ok ? "empty" : res.reason };
  }
  const content = res.text.trim();
  const recordId = await slots.saveRecord(userId, jobId, slotId, kind, content);
  return { ok: true, recordId, content };
}

/**
 * Runs a story_generate / prompt_generate job on Cloudflare. Resumable: slots already
 * validated for this job are never regenerated, so an interrupted run continues where
 * it stopped. Repairs: at most one per scene, marked repaired_unverified.
 */
export async function runCloudStoryJob(job: JobRun, prompt: string, opts: { call?: Call } = {}): Promise<void> {
  const call = opts.call ?? defaultCall;
  const userId = job.userId;
  const jobId = job.id;
  const count = parseSceneCount(prompt);
  const contract = sceneContract(prompt);

  await slots.ensureSlots();
  await setStage(jobId, "planning");

  // Slot 1: Master Blueprint (resume-aware).
  const existing = await slots.listSlots(userId, jobId);
  let blueprint = "";
  let blueprintRef: string | null = null;
  const bp = existing.find((s) => s.slot_id === SLOT_LIMITS.blueprintSlot);
  if (bp?.status === "validated" && bp.result_ref) {
    blueprintRef = bp.result_ref;
    blueprint = (await slots.readRecord(userId, bp.result_ref))?.content ?? "";
  } else {
    if (!(await slots.claimFixedSlot(userId, jobId, 1))) return fail(jobId, "The blueprint slot is held by another task.");
    const r = await generateIntoSlot(userId, jobId, 1, "blueprint", [
      { role: "system", content: "Create a master blueprint for the requested story: setting, characters (names, appearance, clothing), rules and constraints. Concise and structured; no prose story." },
      { role: "user", content: prompt },
    ], STORY_LIMITS.maxBlueprintTokens, call);
    if (!r.ok) return fail(jobId, `Blueprint generation failed: ${r.error}`);
    blueprintRef = r.recordId!; blueprint = r.content!;
    await slots.setSlotStatus(userId, jobId, 1, "validated", { result_ref: blueprintRef });
  }

  // Slot 2: Story (resume-aware).
  let story = "";
  let storyRef: string | null = null;
  const st = (await slots.listSlots(userId, jobId)).find((s) => s.slot_id === SLOT_LIMITS.storySlot);
  if (st?.status === "validated" && st.result_ref) {
    storyRef = st.result_ref;
    story = (await slots.readRecord(userId, st.result_ref))?.content ?? "";
  } else {
    if (!(await slots.claimFixedSlot(userId, jobId, 2))) return fail(jobId, "The story slot is held by another task.");
    const r = await generateIntoSlot(userId, jobId, 2, "story", [
      { role: "system", content: `Write the full story in exactly ${count} scenes, exactly following the blueprint. Keep characters, clothing, setting and rules consistent. ${contract}` },
      { role: "user", content: `Blueprint:\n${blueprint}\n\nRequest:\n${prompt}` },
    ], STORY_LIMITS.maxStoryTokens, call);
    if (!r.ok) return fail(jobId, `Story generation failed: ${r.error}`);
    storyRef = r.recordId!; story = r.content!;
    await slots.setSlotStatus(userId, jobId, 2, "validated", { result_ref: storyRef, blueprint_ref: blueprintRef });
  }

  if (await cancelRequested(jobId)) return;

  // Slots 3+: one scene prompt per slot, in order, resumable.
  const claimedIds = await slots.claimPromptSlots(userId, jobId, count);
  if (claimedIds.length < count) {
    return fail(jobId, `Only ${claimedIds.length} of ${count} scene slots are free right now.`);
  }
  const scenes: string[] = [];
  let failedScenes = 0;
  for (let i = 0; i < count; i++) {
    if (await cancelRequested(jobId)) return;
    const slotId = claimedIds[i];
    await setStage(jobId, `writing_scene_${i + 1}`);
    const current = (await slots.listSlots(userId, jobId)).find((s) => s.slot_id === slotId);
    if (!current) { failedScenes++; continue; }
    if (current.status === "validated" || current.status === "repaired_unverified") {
      scenes.push(current.result_ref ? (await slots.readRecord(userId, current.result_ref))?.content ?? "" : "");
      continue;
    }
    const gen = await generateIntoSlot(userId, jobId, slotId, "prompt", [
      { role: "system", content: contract },
      { role: "user", content: `Blueprint:\n${blueprint}\n\nStory:\n${story}\n\nRequest:\n${prompt}\n\nWrite scene ${i + 1} of ${count}.` },
    ], STORY_LIMITS.maxSceneTokens, call);
    if (!gen.ok) { failedScenes++; continue; }

    const issues = validateScene(gen.content!, i, prompt);
    if (!issues.length) {
      await slots.setSlotStatus(userId, jobId, slotId, "validated", { result_ref: gen.recordId, blueprint_ref: blueprintRef, story_ref: storyRef });
      scenes.push(gen.content!);
      continue;
    }
    // One repair with the exact findings; the result is honestly marked repaired_unverified.
    if (current.repair_attempts >= SLOT_LIMITS.maxRepairAttempts) { failedScenes++; continue; }
    const fix = await call([
      { role: "system", content: "Repair the scene so it satisfies every finding. Return only the corrected scene, keeping the required headings." },
      { role: "user", content: `Findings: ${issues.join(" ")}\n\nOriginal scene:\n${gen.content}` },
    ], STORY_LIMITS.maxSceneTokens);
    if (fix.ok && fix.text.trim()) {
      const recId = await slots.saveRecord(userId, jobId, slotId, "prompt", fix.text.trim());
      await slots.setSlotStatus(userId, jobId, slotId, "repaired_unverified", { result_ref: recId, findings: JSON.stringify(issues), blueprint_ref: blueprintRef, story_ref: storyRef });
      scenes.push(fix.text.trim());
    } else {
      await slots.setSlotStatus(userId, jobId, slotId, "failed", { findings: JSON.stringify(issues), error_code: "repair_failed" });
      failedScenes++;
    }
  }

  if (failedScenes === count) return fail(jobId, "Every scene failed generation or repair.");

  // Assemble in order and run the whole-document contract check before delivery.
  await setStage(jobId, "assembling");
  const doc = assembleStoryDocument({ blueprint, story, scenes });
  const issues = validateAssembled(doc, prompt);
  if (issues.length) {
    return fail(jobId, `The assembled story did not meet the request: ${issues.slice(0, 5).join(" ")}`.slice(0, 400));
  }

  // Hand off to the existing finalizer: store privately, mark uploaded.
  const bytes = new TextEncoder().encode(doc);
  const { putD1Artifact } = await import("@/lib/jobs/artifact-store.server");
  const stored = await putD1Artifact(bytes);
  const hash = await sha256Hex(bytes);
  await d1(
    "UPDATE runtime_jobs SET status = 'uploaded', output_key = ?, output_chunks = ?, output_size = ?, output_sha256 = ?, output_name = ?, result = ?, updated_at = ? WHERE job_id = ? AND status = 'running'",
    [stored.key, stored.chunks, bytes.length, hash, "story.md", JSON.stringify({ scenes: count, failedScenes, engine: "cloudflare-slots" }), now(), jobId],
  );
}
