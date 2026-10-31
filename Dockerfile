# ---- 1) build the React frontend ----
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2) the app: FastAPI serves the API and the built frontend on one port ----
FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces (and many hosts) run containers as a non-root user
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /home/user/app

# CPU-only torch first: far smaller than the default CUDA build
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=user . .
COPY --chown=user --from=web /web/dist ./frontend/dist
RUN mkdir -p data uploads logs knowledge_base

# Serving over https behind the host's proxy: mark the login cookie secure
ENV AUTH_COOKIE_SECURE=true
EXPOSE 7860
# One process only: job progress and rate limits live in memory
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips='*'"]
