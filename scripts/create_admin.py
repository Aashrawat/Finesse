
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from core.auth import service
from core.auth.db import get_db


def main() -> None:
    email = (os.getenv("ADMIN_EMAIL") or "").strip().lower()
    password = os.getenv("ADMIN_PASSWORD") or ""
    name = (os.getenv("ADMIN_NAME") or "Admin").strip()
    if not email or not password:
        raise SystemExit("Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment.")
    users = get_db().users
    existing = users.find_one({"email": email})
    if existing is None:
        user = service.create_user(name, email, password)
        print("created admin account")
    else:
        users.update_one(
            {"_id": existing["_id"]},
            {"$set": {
                "password_hash": service.hash_password(service.check_password(password)),
                "plan": "premium",
                "role": "admin",
                "email_verified": True,
            }},
        )
        print("updated existing account to admin + premium")
    user = users.find_one({"email": email})
    print("email_set=yes", "plan=" + user.get("plan", ""), "role=" + user.get("role", ""))


if __name__ == "__main__":
    main()
