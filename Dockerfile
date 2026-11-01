# ---- 1) build the React frontend ----
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Express upload server (Cloudinary + Multer). Installed here so the runtime image can run it with Node 22.
WORKDIR /upload
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 2) the app: FastAPI serves the API and the built frontend on one port ----
FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

# The app itself runs as a non-root user (see entrypoint.sh)
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
COPY --from=web --chown=user:user /upload/node_modules ./node_modules
COPY --from=web /usr/local/bin/node /usr/local/bin/node
ENV UPLOAD_AUTOSTART=0
RUN mkdir -p data && sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

# Everything the app writes lives under ./data, so a host with ONE persistent disk
# (Render: mount it at /home/user/app/data) keeps accounts' chats, uploads, exports and the models.
ENV UPLOAD_DIR=data/uploads \
    EXPORT_DIR=data/exports \
    CHROMA_DIR=data/vector_db \
    DOWNLOAD_DIR=data/downloads \
    KB_DOCS_DIR=data/knowledge_base \
    KB_REQUEST_LOG=data/logs/chat_requests.jsonl \
    XDG_CACHE_HOME=/home/user/app/data/cache \
    HF_HOME=/home/user/app/data/cache/huggingface

# Serving over https behind the host's proxy: mark the login cookie secure
ENV AUTH_COOKIE_SECURE=true
EXPOSE 7860

# Starts as root only to fix the disk's ownership, then drops to "user"
USER root
ENTRYPOINT ["/home/user/app/entrypoint.sh"]
# One uvicorn process: job progress and rate limits live in memory. Node only handles image uploads.
CMD ["sh", "-c", "node server/index.js & uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips='*'"]
