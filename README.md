---
title: Finesse
emoji: 🎬
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# Finesse

AI video and audio assistant with a knowledge-base chatbot.

- Backend: FastAPI (`api/`, `core/`, `utils/`)
- Frontend: React + Vite + Tailwind (`frontend/`)
- One container serves both (see `Dockerfile`)

## Run locally

```bash
python -m uvicorn api.main:app --port 8000 --reload   # backend
cd frontend && npm run dev                            # frontend
```

Settings go in `.env` (never commit it): `OPENAI_API_KEY`, `MONGODB_URI`, `SMTP_*` / `RESEND_API_KEY`, `STRIPE_*`.

## Deploy

- **Render:** `render.yaml` (Blueprint).
- **Hugging Face Spaces:** this file's header configures a Docker Space; add the keys under *Settings → Secrets*.
