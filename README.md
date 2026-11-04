---
title: Finesse
emoji: 🎬
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

Finesse chat uses the current conversation and its attachments. Shared knowledge-base storage and search are disabled.

Answers adapt to the question: explanations can include examples, code, and useful steps, while simple questions stay brief. The Pro picker controls which GPT answers each message.

The completion budget includes the model's reasoning tokens as well as the visible answer. History is kept within each plan's turn and token limits; older turns are summarized in the background. Restart the backend after changing these settings.

Automatic MCP tools are integrated into the existing chat: Google Search via SerpAPI and Wikipedia.
GitHub and database MCP integrations are removed for now. See [the integration and Hugging Face setup guide](docs/MCP_INTEGRATION.md)
for dependencies, environment settings, secrets, permissions, optional remote servers and tests.
