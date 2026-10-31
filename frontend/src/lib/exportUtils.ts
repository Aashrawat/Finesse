import { formatClock, plainText, slugify } from "@/lib/format";
import type { Video } from "@/lib/types";

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, mime = "text/plain") {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** The extra sections the backend extracts (action items etc.), skipping empty ones. */
function extraSections(video: Video): [string, string][] {
  return (
    [
      ["ACTION ITEMS", video.extras.action_items],
      ["KEY DECISIONS", video.extras.decisions],
      ["OPEN QUESTIONS", video.extras.questions],
    ] as [string, string][]
  )
    .map(([heading, body]): [string, string] => [heading, plainText(body)])
    .filter(([, body]) => body.length > 0);
}

export function exportTxt(video: Video): string {
  const lines: string[] = [
    video.title.toUpperCase(),
    `Source: ${video.source_ref} · Duration: ${formatClock(video.duration)}`,
    "",
    "TL;DR",
    video.summary.tldr,
    "",
    "KEY POINTS",
    ...video.summary.key_points.map((p, i) => `${i + 1}. ${p}`),
    "",
  ];
  if (video.summary.topics.length) {
    lines.push("TOPICS", video.summary.topics.map((t) => `#${t}`).join("  "), "");
  }
  for (const [heading, body] of extraSections(video)) lines.push(heading, body, "");
  lines.push("TRANSCRIPT");
  for (const seg of video.transcript) {
    lines.push(`[${formatClock(seg.start)}] ${seg.speaker}: ${seg.text}`);
  }

  const filename = `${slugify(video.title)}.txt`;
  downloadText(lines.join("\n"), filename);
  return filename;
}

/** jsPDF's built-in fonts only cover Latin-1, so swap common unicode characters. */
function pdfSafe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2022/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x00-\xff]/g, "?");
}

export async function exportPdf(video: Video): Promise<string> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const textW = pageW - margin * 2;
  let y = 0;

  const drawHeader = () => {
    doc.setFillColor(0, 0, 0);
    doc.rect(0, 0, pageW, 120, "F");
    doc.setFont("courier", "bold");
    doc.setFontSize(9);
    doc.setTextColor(204, 255, 0);
    doc.text("FINESSE · AI VIDEO BRIEF", margin, 38);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(255, 255, 255);
    const titleLines = doc.splitTextToSize(pdfSafe(video.title), textW).slice(0, 2);
    doc.text(titleLines, margin, 66);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(163, 163, 178);
    doc.text(pdfSafe(`${video.source_ref} · ${formatClock(video.duration)}`).slice(0, 110), margin, 108);
    doc.setFillColor(204, 255, 0);
    doc.rect(0, 120, pageW, 3, "F");
    y = 150;
  };

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const heading = (text: string) => {
    ensureSpace(40);
    doc.setFillColor(204, 255, 0);
    doc.rect(margin, y - 10, 6, 14, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(20, 22, 31);
    doc.text(text, margin + 14, y);
    y += 22;
  };

  const paragraph = (text: string, font: "helvetica" | "courier" = "helvetica", size = 10.5) => {
    doc.setFont(font, "normal");
    doc.setFontSize(size);
    doc.setTextColor(40, 42, 54);
    for (const line of doc.splitTextToSize(pdfSafe(text), textW) as string[]) {
      ensureSpace(size + 6);
      doc.text(line, margin, y);
      y += size + 5;
    }
  };

  drawHeader();

  heading("TL;DR");
  paragraph(video.summary.tldr);
  y += 10;

  heading("Key points");
  video.summary.key_points.forEach((point, i) => paragraph(`${i + 1}. ${point}`));
  y += 10;

  if (video.summary.topics.length) {
    heading("Topics");
    paragraph(video.summary.topics.map((t) => `#${t}`).join("   "));
    y += 10;
  }

  for (const [title, body] of extraSections(video)) {
    heading(title.charAt(0) + title.slice(1).toLowerCase());
    paragraph(body);
    y += 10;
  }

  heading("Transcript");
  for (const seg of video.transcript) {
    ensureSpace(40);
    doc.setFont("courier", "bold");
    doc.setFontSize(9);
    doc.setTextColor(90, 94, 120);
    doc.text(`[${formatClock(seg.start)}]  ${pdfSafe(seg.speaker).toUpperCase()}`, margin, y);
    y += 13;
    paragraph(seg.text);
    y += 4;
  }

  const filename = `${slugify(video.title)}.pdf`;
  doc.save(filename);
  return filename;
}
