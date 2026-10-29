import os
import re
from datetime import datetime

from fpdf import FPDF

EXPORT_DIR = "exports"

SECTIONS = [
    ("Summary", "summary"),
    ("Action Items", "action_items"),
    ("Key Decisions", "decisions"),
    ("Open Questions", "questions"),
    ("Full Transcript", "transcript"),
]


def _safe_filename(title: str) -> str:
    name = re.sub(r"[^\w\- ]+", "", title).strip().replace(" ", "_")
    return name[:60] or "meeting"


def _base_path(title: str) -> str:
    os.makedirs(EXPORT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(EXPORT_DIR, f"{_safe_filename(title)}_{stamp}")


def _strip_markdown(text: str) -> str:
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)  # headings
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return text


def _pdf_safe(text: str) -> str:
    """fpdf2's built-in fonts only support latin-1; swap common unicode and drop the rest."""
    replacements = {
        "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
        "\u2013": "-", "\u2014": "-", "\u2022": "-", "\u2026": "...", "\u00a0": " ",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text.encode("latin-1", "replace").decode("latin-1")


def export_txt(results: dict) -> str:
    """results keys: title, summary, action_items, decisions, questions, transcript"""
    path = _base_path(results.get("title", "meeting")) + ".txt"
    lines = [results.get("title", "Meeting").upper(), "=" * 60, ""]
    for heading, key in SECTIONS:
        content = results.get(key)
        if content:
            lines += [heading.upper(), "-" * len(heading), _strip_markdown(content).strip(), ""]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def export_pdf(results: dict) -> str:
    path = _base_path(results.get("title", "meeting")) + ".pdf"

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 18)
    pdf.multi_cell(0, 10, _pdf_safe(results.get("title", "Meeting")), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "I", 10)
    pdf.cell(0, 8, datetime.now().strftime("Generated %Y-%m-%d %H:%M"), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    for heading, key in SECTIONS:
        content = results.get(key)
        if not content:
            continue
        pdf.set_font("Helvetica", "B", 14)
        pdf.cell(0, 10, heading, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
        pdf.multi_cell(0, 6, _pdf_safe(_strip_markdown(content).strip()), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(4)

    pdf.output(path)
    return path
