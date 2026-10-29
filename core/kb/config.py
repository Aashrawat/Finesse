"""Settings for the knowledge-base chatbot. Everything can be overridden from .env."""

import os

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


# --- Models ------------------------------------------------------------------
EMBED_MODEL = os.getenv("KB_EMBED_MODEL", "text-embedding-3-small")
CHAT_MODEL = os.getenv("KB_CHAT_MODEL", "gpt-4o-mini")
# Cheap model for the helper calls (query rewriting, history summaries, reranking)
HELPER_MODEL = os.getenv("KB_HELPER_MODEL", "gpt-4o-mini")
OPENAI_MAX_RETRIES = _int("KB_OPENAI_MAX_RETRIES", 4)  # SDK retries with exponential backoff
OPENAI_TIMEOUT = _float("KB_OPENAI_TIMEOUT", 60.0)

# --- Ingestion ---------------------------------------------------------------
DOCS_DIR = os.getenv("KB_DOCS_DIR", "knowledge_base")
SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".docx"}
CHUNK_TOKENS = _int("KB_CHUNK_TOKENS", 700)  # 500-800
CHUNK_OVERLAP = _int("KB_CHUNK_OVERLAP", 100)
EMBED_BATCH_SIZE = _int("KB_EMBED_BATCH_SIZE", 64)

# --- Vector DB (ChromaDB, local) ----------------------------------------------
CHROMA_PATH = os.getenv("KB_CHROMA_PATH", os.path.join("data", "kb_chroma"))
COLLECTION = os.getenv("KB_COLLECTION", "knowledge_base")

# --- Retrieval ---------------------------------------------------------------
TOP_K = _int("KB_TOP_K", 6)
MIN_SIMILARITY = _float("KB_MIN_SIMILARITY", 0.25)  # cosine similarity; chunks below this are dropped
RERANK = _bool("KB_RERANK", False)  # LLM rerank of 2x candidates; adds one call per question

# --- Conversation memory -----------------------------------------------------
HISTORY_TURNS = _int("KB_HISTORY_TURNS", 6)  # last N user/assistant exchanges sent to the model
HISTORY_TOKEN_BUDGET = _int("KB_HISTORY_TOKEN_BUDGET", 1500)
CHATS_DIR = os.getenv("KB_CHATS_DIR", os.path.join("data", "chats"))

# --- Limits / logging ----------------------------------------------------------
CHAT_RATE_LIMIT = _int("KB_CHAT_RATE_LIMIT", 20)  # requests per minute per session
INGEST_RATE_LIMIT = _int("KB_INGEST_RATE_LIMIT", 3)  # per minute per session
MAX_MESSAGE_CHARS = _int("KB_MAX_MESSAGE_CHARS", 4000)
REQUEST_LOG = os.getenv("KB_REQUEST_LOG", os.path.join("logs", "chat_requests.jsonl"))

# The system prompt, exactly as specified
SYSTEM_PROMPT = (
    "You are a helpful, friendly assistant. Answer using the provided context whenever it is relevant, "
    "and cite sources as [source: filename, page]. If the context does not contain the answer, say you "
    "don't have that information in the knowledge base instead of guessing. You may answer general "
    "conversational questions (greetings, clarifications) without context. Keep answers clear and concise, "
    "and use markdown for formatting."
)
