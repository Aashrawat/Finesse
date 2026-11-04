
import asyncio
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import replace
from typing import Any, AsyncIterator

import openai

from core.kb import attachments, config, guest, imagegen, memory, plans, usage as plan_usage
from core.kb.attachments import Attachment, AttachmentError, Upload
from core.kb.clients import async_client
from core.kb.identity import IDENTITY_REPLY, is_identity_question
from core.kb.retrieval import Usage, rewrite_query, summarize_history
from core.agent import settings as agent_settings
from core.agent.security import Actor

# ---- request log (JSON lines: prompt, retrieved chunks, answer, latency, tokens) ----------

_log_lock = threading.Lock()
_logger = logging.getLogger("kb.chat")


def log_request(record: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(config.REQUEST_LOG) or ".", exist_ok=True)
        with _log_lock, open(config.REQUEST_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        _logger.exception("could not write the request log")


# ---- helpers ------------------------------------------------------------------------------

def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def build_messages(
    question: str, history: list[dict[str, str]], summary: str
) -> list[dict[str, str]]:
    """General chat uses the assistant instruction and this conversation's own history."""
    messages: list[dict[str, str]] = [{"role": "system", "content": config.SYSTEM_PROMPT}]
    if summary:
        messages.append({"role": "system", "content": f"Summary of the earlier conversation: {summary}"})
    messages.extend(history)
    messages.append({"role": "user", "content": question})
    return messages


def build_attached_messages(
    question: str,
    doc_context: str,
    history: list[dict[str, Any]],
    summary: str,
    images: list[Attachment],
    new_files: list[Attachment] | None = None,
    set_aside: list[str] | None = None,
) -> list[dict[str, Any]]:
    """system instruction + attached-document text + (summary) + history + question with this turn's images"""
    messages: list[dict[str, Any]] = [{"role": "system", "content": config.ATTACH_SYSTEM_PROMPT}]
    if new_files:
        # name the new files right next to the question, so the model can't mistake them for an earlier file
        question = "[Attached with this message: " + ", ".join(f.name for f in new_files) + "]\n" + question
        note = (
            "The user just attached " + ", ".join(f.name for f in new_files) + " with this message. "
            "Answer about these new files unless the user clearly refers to something discussed earlier. "
            "Earlier answers in this conversation may be about other files; do not carry their content over."
        )
        if set_aside:
            note += (
                " Files attached earlier (" + ", ".join(set_aside) + ") are not shown now; if the user asks "
                "about them, say they need to attach them again."
            )
        messages.append({"role": "system", "content": note})
    if doc_context:
        messages.append({"role": "system", "content": doc_context})
    if summary:
        messages.append({"role": "system", "content": f"Summary of the earlier conversation: {summary}"})
    messages.extend(history)
    if images:
        parts: list[dict[str, Any]] = [{"type": "text", "text": question}]
        parts += [attachments.image_content(a) for a in images]
        messages.append({"role": "user", "content": parts})
    else:
        messages.append({"role": "user", "content": question})
    return messages


def friendly_error(exc: Exception) -> str:
    if isinstance(exc, AttachmentError):
        return str(exc)
    if isinstance(exc, TimeoutError):
        return "This reply took too long to complete. Try a narrower question or ask me to continue."
    if isinstance(exc, openai.AuthenticationError):
        return "The OpenAI API key was rejected. Check OPENAI_API_KEY in your .env file."
    if isinstance(exc, openai.RateLimitError):
        return "OpenAI is rate limiting this key (or the quota is used up). Please try again in a moment."
    if isinstance(exc, (openai.APIConnectionError, openai.APITimeoutError)):
        return "Couldn't reach OpenAI. Check your internet connection and try again."
    if isinstance(exc, openai.BadRequestError):
        return "OpenAI rejected the request. Try a shorter message."
    if isinstance(exc, openai.APIStatusError):
        return f"OpenAI returned an error ({exc.status_code}). Please try again."
    if isinstance(exc, RuntimeError):
        return str(exc)
    return "Something went wrong while generating the answer."


def _save_turn(
    conv: dict[str, Any], question: str, answer: str, sources: list[dict], stopped: bool,
    files: list[Attachment] | None = None, images: list[dict[str, Any]] | None = None,
    model: str | None = None,
    plan: plans.Plan | None = None,
    external_sources: list[dict] | None = None,
    private_owner: str | None = None,
    database_context: bool = False,
) -> None:
    """Append the turn to memory (re-reading under the lock so a background summary isn't lost).
    `images`: pictures the chatbot generated for this answer (kept apart from the user's attachments)."""
    with memory.lock_for(conv["id"]):
        current = memory.store.get(conv["session_id"], conv["id"]) or conv
        stamp = memory.now()
        user_message: dict[str, Any] = {
            "id": uuid.uuid4().hex[:12], "role": "user", "content": question, "sources": [], "created_at": stamp
        }
        if files:
            user_message["attachments"] = [a.meta() for a in files]
        current["messages"].append(user_message)
        reply: dict[str, Any] = {
            "id": uuid.uuid4().hex[:12], "role": "assistant", "content": answer, "sources": sources,
            "created_at": memory.now(), "stopped": stopped,
        }
        if images:
            reply["images"] = images
        if model:
            reply["model"] = model
        if external_sources:
            reply["external_sources"] = external_sources
        if private_owner:
            current["private_owner"] = private_owner
            current["database_context"] = bool(current.get("database_context") or database_context)
        current["messages"].append(reply)
        memory.store.save(current)
    threading.Thread(
        target=memory.compress, args=(conv["session_id"], conv["id"], summarize_history, plan), daemon=True
    ).start()


# ---- the turn ------------------------------------------------------------------------------

async def _read_uploads(uploads: list[Upload]) -> AsyncIterator[tuple[str, Attachment | None]]:
    """Read each file in a worker thread. Yields ("status text", None) before a file, then ("", attachment)."""
    for upload in uploads:
        yield f"Reading {upload.name}…", None
        yield "", await asyncio.to_thread(attachments.read_upload, upload)


def _last_reply_had_image(conv: dict[str, Any]) -> bool:
    """Was the assistant's latest message a generated image? (Then "make it blue" is an edit request.)"""
    for message in reversed(conv["messages"]):
        if message["role"] == "assistant":
            return bool(message.get("images"))
    return False


def _charge(
    conv: dict[str, Any], question: str, answer: str, files: list[Attachment],
    user_id: str | None, images: int, is_guest: bool,
) -> None:
    """A finished turn counts against the visitor's allowance: a guest's free allowance (core.kb.guest), or
    a logged-in user's daily limits (core.kb.plans)."""
    try:
        if user_id:
            plan_usage.record(user_id, messages=1, images=images)
        elif is_guest:
            guest.record(conv["session_id"], len(files), guest.chat_tokens(question, answer))
    except Exception:
        _logger.exception("could not record usage")


def _model_options(model: str) -> dict[str, Any]:
    """A generous completion budget, with only the sampling options each model family supports."""
    options: dict[str, Any] = {"max_completion_tokens": config.MAX_COMPLETION_TOKENS}
    if model.startswith(("gpt-4", "gpt-3")):
        options["temperature"] = 0.2
    elif config.REASONING_EFFORT:
        options["reasoning_effort"] = config.REASONING_EFFORT
    return options


async def stream_chat(
    conv: dict[str, Any], question: str, uploads: list[Upload] | None = None, is_guest: bool = False,
    plan: plans.Plan | None = None, user_id: str | None = None,
    hosted_images: list[Attachment] | None = None,
    model: str | None = None,
    actor: Actor | None = None,
) -> AsyncIterator[str]:
    """`question` is what the user typed (may be empty when they only attached files).
    `is_guest`: the visitor is not logged in, so the turn is counted against their free allowance.
    `plan` / `user_id`: a logged-in user's plan (picks the model and the image allowance) and their id."""
    plan = plan or plans.PLANS["free"]
    model = plans.select_model(plan, model)
    started = time.perf_counter()
    usage = Usage()
    parts: list[str] = []
    sources: list[dict[str, Any]] = []
    external_sources: list[dict] = []
    private_owner = conv.get("private_owner")
    database_context = bool(conv.get("database_context"))
    files: list[Attachment] = []  # files attached to this message, once read
    files_on_disk = False
    generated: list[dict[str, Any]] = []  # images the chatbot made for this answer
    standalone = question
    first_token_ms: int | None = None
    status = "error"
    error_message = ""
    saved = False

    try:
        yield sse("meta", {"conversation_id": conv["id"], "title": conv["title"], "model": model})

        async for text, item in _read_uploads(uploads or []):
            if item is None:
                yield sse("status", {"text": text})
            else:
                files.append(item)
        if hosted_images:
            files.extend(hosted_images)
        if files:
            files_on_disk = await asyncio.to_thread(attachments.save, conv["session_id"], conv["id"], files)

        images = [a for a in files if a.kind == "image"]
        # what the model is asked: attached files without a typed question get a sensible default
        ask = question or "Please summarize the attached file(s) and describe what any images show."

        fixed: str | None = None  # a reply written by us instead of the chat model
        if is_identity_question(question) and not files:
            fixed = IDENTITY_REPLY  # "What is your name?" -> the fixed introduction

        # "draw / create an image of ..." -> generate one (only when no files came with the message)
        if fixed is None and config.IMAGES_ENABLED and not files and imagegen.looks_like_request(
            question, after_image=_last_reply_had_image(conv)
        ):
            art = await imagegen.plan(question, memory.recent_history(conv, plan), usage)
            if art is not None:
                standalone = art.prompt
                if is_guest and not config.GUEST_IMAGES:
                    fixed = "Creating images is available after you log in. Log in to explore more."
                elif user_id and (blocked := plans.image_block(user_id, plan)):
                    fixed = blocked  # the plan has no images, or today's images are used up
                elif not imagegen.allow(conv["session_id"]):
                    fixed = (
                        f"You've reached the limit of {config.IMAGE_RATE_LIMIT} images per hour. "
                        "Please try again a little later."
                    )
                else:
                    yield sse("status", {"text": "Creating your image… this can take up to a minute"})
                    task = asyncio.ensure_future(imagegen.generate(art.prompt, art.shape))
                    try:
                        async for beat in imagegen.keep_alive(task):
                            yield beat
                        png, image_model = task.result()
                    finally:
                        if not task.done():
                            task.cancel()  # the user pressed stop, or left
                    image_id = await asyncio.to_thread(attachments.save_generated, conv["session_id"], conv["id"], png)
                    meta = {
                        "id": image_id, "name": "image.png", "mime": "image/png", "size": len(png),
                        "prompt": art.prompt, "model": image_model,
                    }
                    generated.append(meta)
                    yield sse("image", meta)
                    fixed = f"Here's the image I created.\n\n*Prompt used:* {art.prompt[:600]}"

        if fixed is not None:
            # streamed word by word like any other answer
            for piece in re.findall(r"\S+\s*", fixed):
                if first_token_ms is None:
                    first_token_ms = int((time.perf_counter() - started) * 1000)
                parts.append(piece)
                yield sse("token", {"t": piece})
                await asyncio.sleep(0.02)
        else:
            summary = conv.get("summary", "")
            if attachments.has_files(conv, files):
                # Answer from the attached files; the knowledge base is not involved.
                # A message that brings new files starts fresh: earlier questions and answers are about other
                # files, and the model copies their file names and content into the new answer. Follow-up
                # questions (no new files) keep the history.
                history = [] if files else attachments.history_messages(conv, plan=plan)
                if files:
                    summary = ""
                text_history = [{"role": m["role"], "content": m["content"] if isinstance(m["content"], str)
                                 else m["content"][0]["text"]} for m in history]
                # a message that brings its own files is about those files: don't let earlier topics rewrite it
                standalone = ask if files else await rewrite_query(ask, text_history, summary, usage)
                doc_context, sources = await attachments.document_context(conv, files, standalone, usage)
                new_docs = any(a.kind == "document" for a in files)
                messages = build_attached_messages(
                    ask, doc_context, history, summary, images, files,
                    attachments.earlier_documents(conv) if new_docs else [],
                )
            else:
                history = memory.recent_history(conv, plan)
                messages = build_messages(question, history, summary)

            if agent_settings.enabled():
                from core.agent.runner import run
                tool_actor = replace(actor or Actor(), private_context=bool(private_owner))
                async for kind, payload in run(messages, model, tool_actor, usage):
                    if kind == "token":
                        if first_token_ms is None:
                            first_token_ms = int((time.perf_counter() - started) * 1000)
                        parts.append(payload["t"])
                    elif kind == "external_sources":
                        external_sources = payload["sources"]
                    elif kind == "private_context":
                        if payload["private"] and tool_actor.subject != "guest":
                            private_owner = tool_actor.subject
                            database_context = database_context or payload["database"]
                        continue
                    yield sse(kind, payload)
            else:
                stream = await async_client().chat.completions.create(
                    model=model, messages=messages, stream=True,
                    stream_options={"include_usage": True}, **_model_options(model),
                )
                async for event in stream:
                    if event.usage:
                        usage.add_chat(event.usage)
                    if event.choices and event.choices[0].delta.content:
                        piece = event.choices[0].delta.content
                        if first_token_ms is None:
                            first_token_ms = int((time.perf_counter() - started) * 1000)
                        parts.append(piece)
                        yield sse("token", {"t": piece})

        answer = "".join(parts)
        yield sse("sources", {"sources": sources})
        await asyncio.to_thread(_save_turn, conv, question, answer, sources, False, files, generated, model=model, plan=plan, external_sources=external_sources, private_owner=private_owner, database_context=database_context)
        saved = True
        _charge(conv, question, answer, files, user_id, len(generated), is_guest)
        status = "ok"
        yield sse("done", {
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": first_token_ms,
            "usage": usage.as_dict(),
        })
    except (asyncio.CancelledError, GeneratorExit):
        # The client pressed "stop" (or went away): keep what was generated so far.
        status = "stopped"
        raise
    except Exception as exc:
        error_message = type(exc).__name__  # provider errors can contain request URLs or credentials
        if isinstance(exc, AttachmentError):
            _logger.info("attachment rejected: %s", exc)  # the user's file, not a server fault
        else:
            _logger.error("chat request failed type=%s", type(exc).__name__)
        yield sse("error", {"message": friendly_error(exc)})
    finally:
        answer = "".join(parts)
        if status == "stopped" and answer and not saved:
            try:  # synchronous on purpose: awaiting is not allowed while the generator is being closed
                _save_turn(conv, question, answer, sources, True, files, generated, model=model, plan=plan, external_sources=external_sources, private_owner=private_owner, database_context=database_context)
                saved = True
                _charge(conv, question, answer, files, user_id, len(generated), is_guest)
            except Exception:
                _logger.exception("could not save the partial answer")
        if files_on_disk and not saved:
            attachments.discard(conv["session_id"], conv["id"], files)  # the turn was never stored
        if hosted_images and not saved:
            attachments.release_hosted(hosted_images)
        if generated and not saved:
            for meta in generated:
                attachments.discard_generated(conv["session_id"], conv["id"], meta["id"])
        log_request({
            "ts": memory.now(),
            "session_id": conv["session_id"],
            "conversation_id": conv["id"],
            "model": model,
            "external_sources": external_sources,
            "status": status,
            "prompt": question,
            "attachments": [a.name for a in files],
            "standalone_query": standalone,
            "retrieved": [
                {"source": s["source"], "page": s["page"], "chunk_id": s["chunk_id"], "similarity": s["similarity"]}
                for s in sources
            ],
            "answer": answer,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": first_token_ms,
            "usage": usage.as_dict(),
            "error": error_message or None,
        })
