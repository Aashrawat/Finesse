"""Token-based chunking (tiktoken cl100k_base, the encoding used by text-embedding-3-*)."""

from dataclasses import dataclass
from functools import lru_cache

import tiktoken

from core.kb import config


@lru_cache(maxsize=1)
def encoder() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(encoder().encode(text, disallowed_special=()))


@dataclass
class Chunk:
    text: str
    page: int  # page the chunk starts on (0 = document has no pages)
    page_end: int  # page it ends on (== page unless the chunk crosses a page break)
    tokens: int


def chunk_pages(
    pages: list[tuple[int, str]],
    size: int = config.CHUNK_TOKENS,
    overlap: int = config.CHUNK_OVERLAP,
) -> list[Chunk]:
    """Slide a `size`-token window over the whole document, stepping by `size - overlap`.

    The document is treated as one token stream so chunks can span page breaks;
    each chunk records the page its first token belongs to.
    """
    if overlap >= size:
        raise ValueError("chunk overlap must be smaller than the chunk size")

    enc = encoder()
    tokens: list[int] = []
    page_of: list[int] = []
    separator = enc.encode("\n\n")
    for page, text in pages:
        if tokens:
            tokens.extend(separator)
            page_of.extend([page] * len(separator))
        ids = enc.encode(text, disallowed_special=())
        tokens.extend(ids)
        page_of.extend([page] * len(ids))

    chunks: list[Chunk] = []
    start = 0
    total = len(tokens)
    while start < total:
        end = min(start + size, total)
        # decode() can leave U+FFFD where a window edge splits a multi-byte character
        text = enc.decode(tokens[start:end]).replace("\ufffd", "").strip()
        if text:
            chunks.append(Chunk(text=text, page=page_of[start], page_end=page_of[end - 1], tokens=end - start))
        if end == total:
            break
        start = end - overlap
    return chunks
