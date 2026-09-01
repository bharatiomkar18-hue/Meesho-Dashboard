// Local-only test harness (NOT part of the deployed site): serves public/
// as static files and wires /api/data + /api/upload to the real function
// handlers, with @netlify/blobs replaced by an in-memory fake store so this
// can run without real Netlify credentials. Used only to verify app3.js's
// fetch/upload/password/refresh logic end-to-end before deploying for real.
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---- fake in-memory Netlify Blobs ----
const memoryStore = new Map();
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@netlify/blobs') {
    return path.join(__dirname, 'fake-netlify-blobs.js');
  }
  return originalResolve.call(this, request, ...args);
};
fs.writeFileSync(path.join(__dirname, 'fake-netlify-blobs.js'), `
const store = require(${JSON.stringify(path.join(__dirname, 'shared-memory-store.js'))});
exports.getStore = function(name){
  return {
    async get(key, opts){ const v = store.map.get(name + ':' + key); return v == null ? null : v; },
    async setJSON(key, value){ store.map.set(name + ':' + key, value); },
  };
};
`);
fs.writeFileSync(path.join(__dirname, 'shared-memory-store.js'), `
if (!global.__fakeBlobsMap) global.__fakeBlobsMap = new Map();
module.exports = { map: global.__fakeBlobsMap };
`);

const dataFn = require('../netlify/functions/data.js');
const uploadFn = require('../netlify/functions/upload.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/data')) {
    const result = await dataFn.handler({ httpMethod: 'GET' });
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
    return;
  }
  if (req.url.startsWith('/api/upload')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const result = await uploadFn.handler({ httpMethod: 'POST', body });
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
    });
    return;
  }
  // static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, decodeURIComponent(filePath.split('?')[0]));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = process.env.PORT || 8899;
server.listen(PORT, () => console.log('Mock server (fake Blobs) listening on http://localhost:' + PORT));
