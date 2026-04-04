const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadDirectory = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadDirectory);
  },
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    callback(null, `${uniqueSuffix}-${safeName}`);
  },
});

function imageOnlyFilter(_req, file, callback) {
  if (file.mimetype.startsWith("image/")) {
    callback(null, true);
    return;
  }
  callback(new Error("Dozwolone są tylko pliki obrazów."));
}

const uploadEvidence = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: imageOnlyFilter,
});

module.exports = {
  uploadEvidence,
};
