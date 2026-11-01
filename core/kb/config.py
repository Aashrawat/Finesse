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
# Vision model: reads images and scanned / figure-heavy PDF pages (must accept image input)
VISION_MODEL = os.getenv("KB_VISION_MODEL", "gpt-4o")
OPENAI_MAX_RETRIES = _int("KB_OPENAI_MAX_RETRIES", 4)  # SDK retries with exponential backoff
OPENAI_TIMEOUT = _float("KB_OPENAI_TIMEOUT", 60.0)

# --- Ingestion ---------------------------------------------------------------
DOCS_DIR = os.getenv("KB_DOCS_DIR", "knowledge_base")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".docx"} | IMAGE_EXTENSIONS
MAX_VISION_PAGES = _int("KB_MAX_VISION_PAGES", 40)  # per PDF; caps vision cost on huge scanned files
MAX_IMAGE_SIDE = _int("KB_MAX_IMAGE_SIDE", 2048)  # px; larger images are downscaled before vision
CHUNK_TOKENS = _int("KB_CHUNK_TOKENS", 700)  # 500-800
CHUNK_OVERLAP = _int("KB_CHUNK_OVERLAP", 100)
EMBED_BATCH_SIZE = _int("KB_EMBED_BATCH_SIZE", 64)

# --- Files attached to a chat message (like ChatGPT / Claude) ----------------------------------
MAX_ATTACH_MB = _int("KB_MAX_ATTACH_MB", 25)  # per file
MAX_ATTACH_FILES = _int("KB_MAX_ATTACH_FILES", 6)  # per message
MAX_ATTACH_IMAGES = _int("KB_MAX_ATTACH_IMAGES", 4)  # per message
ATTACH_FULL_TOKENS = _int("KB_ATTACH_FULL_TOKENS", 30000)  # documents up to this size are sent in full
ATTACH_TOP_K = _int("KB_ATTACH_TOP_K", 10)  # longer ones: the best N passages for each question
HISTORY_IMAGES = _int("KB_HISTORY_IMAGES", 3)  # earlier images re-sent with follow-up questions

# --- Image generation (the chatbot draws an image when asked to) ----------------------------------
IMAGES_ENABLED = _bool("KB_IMAGES", True)
IMAGE_MODEL = os.getenv("KB_IMAGE_MODEL", "gpt-image-2")  # best quality; may need a verified OpenAI organisation
IMAGE_FALLBACK_MODEL = os.getenv("KB_IMAGE_FALLBACK_MODEL", "gpt-image-1.5")  # used when the first model isn't available
IMAGE_QUALITY = os.getenv("KB_IMAGE_QUALITY", "high")  # gpt-image models: low|medium|high (dall-e-3 gets "hd")
IMAGE_TIMEOUT = _float("KB_IMAGE_TIMEOUT", 240.0)  # seconds; high quality images take a while
IMAGE_RATE_LIMIT = _int("KB_IMAGE_RATE_LIMIT", 10)  # images per hour per session (they cost real money)
GUEST_IMAGES = _bool("KB_GUEST_IMAGES", False)  # may visitors who aren't logged in generate images?

# --- Guests (visitors who are not logged in) ---------------------------------------------------
GUEST_MAX_FILES = _int("KB_GUEST_MAX_FILES", 2)  # files they may attach in total
GUEST_MAX_TOKENS = _int("KB_GUEST_MAX_TOKENS", 1000)  # tokens of chat text (their messages + the answers) in total
GUEST_USAGE_PATH = os.getenv("KB_GUEST_USAGE", os.path.join("data", "guest_usage.json"))
GUEST_LIMIT_MESSAGE = "You've reached the free limit for guests. Log in to explore more."

# --- Plans (Free / Pro / Premium: see core/kb/plans.py for the models and daily limits) ---------------
PLAN_USAGE_PATH = os.getenv("KB_PLAN_USAGE", os.path.join("data", "plan_usage.json"))
# Lets a logged-in user switch their own plan without paying. For development and demos only: leave it off
# in production until real payments are connected.
PLAN_DEV_SWITCH = _bool("PLANS_DEV_SWITCH", False)
# How hard the newer (gpt-5 / gpt-6) models think before answering: minimal|low|medium|high. Lower = faster.
REASONING_EFFORT = os.getenv("KB_REASONING_EFFORT", "low")

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

# Used instead of SYSTEM_PROMPT when the conversation has attached files
ATTACH_SYSTEM_PROMPT = (
    "You are a helpful, friendly assistant. The user has attached files to this conversation: documents "
    "(their text is provided below) and images (shown in the messages). Answer from those files, looking "
    "carefully at images and reading document text closely. When you use a document, cite it as "
    "[source: filename, page N] (leave out the page if it has none). If the files don't contain the answer, "
    "say so; you may still help from general knowledge, but make clear which part is not from the files. "
    "Keep answers clear and concise, and use markdown for formatting."
)

# The system prompt, exactly as specified
SYSTEM_PROMPT = (
    "You are a helpful, friendly assistant. Answer using the provided context whenever it is relevant, "
    "and cite sources as [source: filename, page]. If the context does not contain the answer, say you "
    "don't have that information in the knowledge base instead of guessing. You may answer general "
    "conversational questions (greetings, clarifications) without context. Keep answers clear and concise, "
    "and use markdown for formatting."
)
