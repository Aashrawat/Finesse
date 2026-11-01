const express = require("express");
const multer = require("multer");
const cloud = require("./cloudinary");
const { upload, MAX_IMAGES } = require("./multer");

const app = express();
const port = Number(process.env.UPLOAD_PORT) || 3001;

app.use(express.json({ limit: "32kb" }));

function requireSession(req, res, next) {
  const id = req.get("x-session-id") || "";
  if (!/^[0-9a-f-]{32,36}$/.test(id)) {
    res.status(400).json({ error: "Missing or invalid X-Session-Id header." });
    return;
  }
  next();
}

app.post("/api/upload/delete", async (req, res) => {
  if (!cloud.configured()) {
    res.status(503).json({ error: "Cloudinary is not configured." });
    return;
  }
  const ids = Array.isArray(req.body && req.body.public_ids) ? req.body.public_ids : [];
  const removed = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id.startsWith("finesse/") || id.includes("..")) continue;
    try {
      await cloud.destroyImage(id);
      removed.push(id);
    } catch (err) {
      console.error("Cloudinary delete failed:", err && err.message ? err.message : err);
    }
  }
  res.json({ removed });
});

app.post("/api/upload", requireSession, (req, res, next) => {
  if (!cloud.configured()) {
    res.status(503).json({ error: "Cloudinary is not configured." });
    return;
  }
  next();
}, upload.array("images", MAX_IMAGES), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    res.status(400).json({ error: "Choose an image to upload." });
    return;
  }
  try {
    const images = [];
    for (const file of files) {
      const result = await cloud.uploadImage(file.buffer);
      images.push({
        url: result.secure_url,
        public_id: result.public_id,
        bytes: result.bytes,
        format: result.format,
        mime: file.mimetype,
        original_name: file.originalname || "image",
      });
    }
    res.json({ images });
  } catch (err) {
    console.error("Cloudinary upload failed:", err && err.message ? err.message : err);
    res.status(502).json({ error: "Couldn't store the image. Check the Cloudinary settings and try again." });
  }
});

app.use((err, _req, res, next) => {
  if (!err) {
    next();
    return;
  }
  if (err instanceof multer.MulterError || err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Each image must be 10 MB or smaller." });
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(413).json({ error: `You can upload up to ${MAX_IMAGES} images at a time.` });
      return;
    }
  }
  res.status(400).json({ error: err.message || "Upload failed." });
});

function listen(attempt = 0) {
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Image upload listening on http://127.0.0.1:${port}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < 20) {
      setTimeout(() => listen(attempt + 1), 250);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.log(`Image upload is already running on port ${port}.`);
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
}

listen();
