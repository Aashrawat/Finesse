
import os
import threading

from dotenv import load_dotenv

load_dotenv()

URI_NAMES = ("MONGODB_URI", "MONGO_URI", "MONGODB_URL", "MONGO_URL")


class DatabaseUnavailable(RuntimeError):
    """MongoDB isn't configured or can't be reached."""


_lock = threading.Lock()
_db = None


def mongo_uri() -> str:
    for name in URI_NAMES:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _ensure_indexes(db) -> None:
    db.users.create_index("email", unique=True)
    db.sessions.create_index("token_hash", unique=True)
    db.sessions.create_index("expires_at", expireAfterSeconds=0)  # MongoDB deletes expired logins itself


def get_db():
    """The accounts database (connects on first call)."""
    global _db
    with _lock:
        if _db is not None:
            return _db
        uri = mongo_uri()
        if not uri:
            raise DatabaseUnavailable("Accounts aren't set up yet: add MONGODB_URI to the .env file and restart the backend.")
        try:
            from pymongo import MongoClient
            from pymongo.errors import PyMongoError

            client = MongoClient(uri, serverSelectionTimeoutMS=5000, appname="finesse")
            # Always a database of our own. The URI's default database may belong to another project,
            # and we must never create indexes or documents in someone else's collections.
            db = client[os.getenv("MONGODB_DB", "").strip() or "finesse"]
            _ensure_indexes(db)  # also proves the connection works
        except ImportError:
            raise DatabaseUnavailable("The 'pymongo' package isn't installed (pip install pymongo).")
        except PyMongoError as exc:
            raise DatabaseUnavailable(f"Can't reach the accounts database: {type(exc).__name__}.") from exc
        except Exception as exc:  # e.g. a malformed connection string
            raise DatabaseUnavailable(f"The MongoDB connection string looks invalid ({type(exc).__name__}).") from exc
        _db = db
        return db


def set_db_for_tests(db) -> None:
    global _db
    _db = db
