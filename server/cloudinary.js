const path = require("path");
const cloudinary = require("cloudinary").v2;

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function cloudName() {
  return (process.env.CLOUDINARY_CLOUD_NAME || "").replace(/\s+/g, "");
}

function configured() {
  return Boolean(cloudName() && (process.env.CLOUDINARY_API_KEY || "").trim() && (process.env.CLOUDINARY_API_SECRET || "").trim());
}

function configure() {
  cloudinary.config({
    cloud_name: cloudName(),
    api_key: (process.env.CLOUDINARY_API_KEY || "").trim(),
    api_secret: (process.env.CLOUDINARY_API_SECRET || "").trim(),
    secure: true,
  });
}

/** Upload image bytes. Nothing is written to disk; Cloudinary returns the URL and public id. */
function uploadImage(buffer) {
  configure();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "finesse", resource_type: "image", unique_filename: true },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
    stream.end(buffer);
  });
}

function destroyImage(publicId) {
  configure();
  return cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}

module.exports = { configured, uploadImage, destroyImage, cloudName };
