const fs = require("fs");
const multer = require("multer");
const path = require("path");



const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads')); // absolute path
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});


// File filter to allow images and docs. Anchored so the extension must match
// exactly (e.g. "png", not "notpng"). Images: jpg/jpeg/png/gif/webp/heic — kept
// in sync with the frontend accept list (files-panel acceptTypes).
function fileFilter(req, file, cb) {
  const allowedExtensions = /^(jpeg|jpg|png|gif|webp|heic|pdf|doc|docx|xls|xlsx)$/;
  const ext = path.extname(file.originalname).toLowerCase().substring(1);
  const mime = file.mimetype;

  if (allowedExtensions.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only images (jpg, jpeg, png, gif, webp, heic) and documents (pdf, doc, docx, xls, xlsx) are allowed"));
  }
}

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 250 * 1024 * 1024, 
  },
})

module.exports = {
 
  upload,
 
};

