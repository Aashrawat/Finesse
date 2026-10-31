"""Fixed answer for "what is your name?" style questions.

These are answered with exactly this sentence, before any document search or model call, so the
reply never varies and costs nothing.
"""

import re

IDENTITY_REPLY = "I am Finesse created by Aashrawat. How can I assist you today?"

_GREETING = re.compile(r"^(?:(?:hi|hii+|hello|hey|heya|hiya|yo|ok|okay|so|well|please|pls)\b\s*)+")
_ASKS_WHO_I_AM = re.compile(
    r"\b(?:"
    r"your name|who are you|who r you|what are you called|what should i call you|what do i call you"
    r"|who (?:made|created|built|developed|designed|owns) you|who is your (?:creator|developer|maker|owner)"
    r"|introduce yourself|tell me about yourself"
    r")\b"
)


def _normalize(text: str) -> str:
    text = text.lower().replace("\u2019", "'")
    text = re.sub(r"\bwhat(?:'s|s)\b", "what is", text)
    text = re.sub(r"\b(?:ur|ure)\b", "your", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)  # drop punctuation
    text = re.sub(r"\s+", " ", text).strip()
    # "what is you name" / "tell me u name": a missing "r" is a typo, but only after these openers
    return re.sub(r"\b(what is|tell me|say|whats) (?:you|u|yo) name\b", r"\1 your name", text)


def is_identity_question(text: str) -> bool:
    """True for short questions about the assistant's name or maker ("hi what is your name?")."""
    norm = _normalize(text)
    if not norm or len(norm.split()) > 12:  # a long message is probably about something else
        return False
    return bool(_ASKS_WHO_I_AM.search(_GREETING.sub("", norm)))
