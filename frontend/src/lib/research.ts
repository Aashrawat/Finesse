import type { Critique, ResearchJob } from "@/lib/types";

const stripMd = (s: string) => s.replace(/\*\*|__|`/g, "").trim();

/**
 * Parse the critic's fixed format:
 *   Score: X/10 / Strength: - … / Areas to improve: - … / One line verdict: - …
 * Returns null when nothing recognisable is found, so the UI can show the raw text instead.
 */
export function parseCritique(text: string): Critique | null {
  const critique: Critique = { score: null, strengths: [], improvements: [], verdict: "" };
  let section: "strengths" | "improvements" | "verdict" | null = null;

  for (const raw of text.split("\n")) {
    const line = stripMd(raw);
    if (!line) continue;
    const lower = line.toLowerCase();

    const score = lower.match(/^score\s*:?\s*(\d+(?:\.\d+)?)\s*\/\s*10/);
    if (score) {
      critique.score = Number(score[1]);
      section = null;
      continue;
    }
    if (lower.startsWith("strength")) { section = "strengths"; continue; }
    if (lower.startsWith("areas to improve") || lower.startsWith("improve")) { section = "improvements"; continue; }
    if (lower.startsWith("one line verdict") || lower.startsWith("verdict")) {
      section = "verdict";
      const inline = line.split(":").slice(1).join(":").trim();
      if (inline) critique.verdict = inline;
      continue;
    }

    const item = line.replace(/^[-*•]\s*/, "");
    if (section === "strengths") critique.strengths.push(item);
    else if (section === "improvements") critique.improvements.push(item);
    else if (section === "verdict") critique.verdict = critique.verdict ? `${critique.verdict} ${item}` : item;
  }

  const found = critique.score !== null || critique.strengths.length || critique.improvements.length || critique.verdict;
  return found ? critique : null;
}

/** A single markdown document of the whole run, for download / copy. */
export function researchToMarkdown(job: ResearchJob): string {
  const result = job.result;
  if (!result) return "";
  return [
    `# ${job.topic}`,
    "",
    result.report.trim(),
    "",
    "---",
    "",
    "## Critic review",
    "",
    result.feedback.trim(),
    "",
  ].join("\n");
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "research";
