const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server');

const storageDir = process.env.STORAGE_DIR || path.join(os.tmpdir(), 'quickdrop');
const app = createApp({ storageDir });

module.exports = (req, res) => {
  if (req.headers['x-matched-path']) {
    req.url = req.headers['x-matched-path'];
  }
  return app.handler(req, res);
};
