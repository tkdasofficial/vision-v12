// Pure contract and assembly logic for Cloudflare-native story/prompt generation.
// No I/O — shared by the server runner and tests.
import { requestedStoryFields, storyDialogueRange, spokenStoryWords, requiresFixedStoryBackground } from "../ai/story-output";
import { validateRuntimeStory } from "./story-validation";
import { SLOT_LIMITS } from "../sandbox/slots";

export const STORY_LIMITS = {
  defaultScenes: 5,
  maxScenes: SLOT_LIMITS.maxPromptsPerRequest, // 25
  maxBlueprintTokens: 1200,
  maxStoryTokens: 4096,
  maxSceneTokens: 1500,
} as const;

/** Extracts the requested scene/prompt count; defaults to 5, capped at 25. */
export function parseSceneCount(prompt: string): number {
  const m = /(\d{1,2})\s*[- ]?(?:scenes?|prompts?|chapters?|episodes?|parts?)\b/i.exec(prompt);
  const n = m ? Number(m[1]) : STORY_LIMITS.defaultScenes;
  if (!Number.isInteger(n) || n < 1) return STORY_LIMITS.defaultScenes;
  return Math.min(n, STORY_LIMITS.maxScenes);
}

const FIELD_HEADINGS: Record<string, string> = {
  action: "Story Line", visual: "Visual Prompt", dialogue: "Dialogue", environment: "Environment", camera: "Camera Direction",
};

/** Ordered section headings a scene must contain, derived from the request's delivery clauses. */
export function sceneHeadings(prompt: string): string[] {
  const fields = requestedStoryFields(prompt);
  return (fields.length ? fields : ["visual", "dialogue"]).map((f) => FIELD_HEADINGS[f]);
}

/** The exact per-scene format instruction given to the writer. */
export function sceneContract(prompt: string): string {
  const headings = sceneHeadings(prompt);
  const bounds = storyDialogueRange(prompt);
  const lines = [
    `Write exactly one scene. Use the heading "## Scene N" (with the real scene number), then exactly these subsections, in this order, each as a "###" heading: ${headings.join(", ")}.`,
    "Do not add any other sections, headings, commentary or summaries.",
  ];
  if (bounds && headings.includes("Dialogue")) {
    lines.push(`The Dialogue subsection must contain ${bounds.min} to ${bounds.max} spoken words. Speaker labels and parenthetical directions do not count toward the word total.`);
  }
  if (requiresFixedStoryBackground(prompt)) {
    lines.push("Keep the same single background/setting in every scene; never move the characters to a new location.");
  }
  lines.push("Keep every character's name, appearance and clothing exactly as established in the blueprint and story.");
  return lines.join(" ");
}

/** Deterministic per-scene validation against the request contract. Returns issue strings. */
export function validateScene(sceneText: string, sceneIndex: number, prompt: string): string[] {
  const wrapped = sceneText.replace(/^##\s*Scene\s+\d+/i, `## Scene ${sceneIndex + 1}`);
  return validateRuntimeStory(wrapped, prompt).map((issue) => issue.replace(/^Scene \d+/, `Scene ${sceneIndex + 1}`));
}

/** Assembles the final Markdown document in order: blueprint, story, then scenes 1..N. */
export function assembleStoryDocument(input: { title?: string; blueprint: string; story: string; scenes: string[] }): string {
  const parts: string[] = [];
  parts.push(`# ${input.title?.trim() || "Generated Story"}`);
  if (input.blueprint.trim()) parts.push(`## Master Blueprint\n\n${input.blueprint.trim()}`);
  if (input.story.trim()) parts.push(`## Story\n\n${input.story.trim()}`);
  for (const scene of input.scenes) {
    const text = scene.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n") + "\n";
}

/** Whole-document contract check used before delivery (same validator the job finalizer runs). */
export function validateAssembled(doc: string, prompt: string): string[] {
  return validateRuntimeStory(doc, prompt);
}
