"""Read PDF / TXT / MD / DOCX files into a list of (page_number, text).

Page numbers are real for PDFs. Formats without pages (TXT, MD, DOCX) are a single
"page 0", which the UI and citations treat as "no page".
"""

from pathlib import Path


class EmptyDocument(Exception):
    """The file was readable but contains no extractable text (e.g. a scanned PDF)."""


def _load_pdf(path: Path) -> list[tuple[int, str]]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:
            raise ValueError("PDF is password protected") from exc
    pages = []
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append((number, text))
    return pages


def _load_text(path: Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8-sig", errors="replace").strip()
    return [(0, text)] if text else []


def _load_docx(path: Path) -> list[tuple[int, str]]:
    from docx import Document

    doc = Document(str(path))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    text = "\n".join(parts).strip()
    return [(0, text)] if text else []


_LOADERS = {
    ".pdf": _load_pdf,
    ".txt": _load_text,
    ".md": _load_text,
    ".docx": _load_docx,
}


def load_document(path: Path) -> list[tuple[int, str]]:
    loader = _LOADERS.get(path.suffix.lower())
    if loader is None:
        raise ValueError(f"Unsupported file type '{path.suffix}'")
    pages = loader(path)
    if not pages:
        raise EmptyDocument("No extractable text found")
    return pages
