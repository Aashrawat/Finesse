const multer = require("multer");

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 4;

// Memory storage: the bytes go to Cloudinary and are never saved as a file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_IMAGES },
  fileFilter(_req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image files can be uploaded."));
  },
});

module.exports = { upload, MAX_BYTES, MAX_IMAGES };
