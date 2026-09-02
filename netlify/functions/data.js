// GET /api/data  ->  /.netlify/functions/data
// Returns the currently-stored shared dataset (or { empty: true } if nobody
// has uploaded one yet). Read-only, no password required, viewing the
// dashboard is open to anyone with the link.
const { connectLambda, getStore } = require("@netlify/blobs");
const zlib = require("zlib");

const STORE_NAME = "meesho-elasticrun-dashboard";
const KEY = "current";
// Responses over this size get gzip-compressed and base64-wrapped (see
// app3.js's gunzipBase64JSON) to stay clear of Netlify Functions' ~6 MB
// response-body limit as reports grow.
const COMPRESS_ABOVE_BYTES = 1000000;

// connectLambda(event) manually wires up this invocation's Blobs context.
// This deploy's automatic wiring wasn't kicking in on its own (that's what
// caused the earlier MissingBlobsEnvironmentError), and this is Netlify's
// own documented fix for that. BLOBS_SITE_ID + BLOBS_TOKEN env vars (see
// DEPLOY.md) remain as a manual fallback if that ever stops being enough.
function getBlobStore(event) {
    if (event && event.blobs) connectLambda(event);
    const siteID = process.env.BLOBS_SITE_ID;
    const token = process.env.BLOBS_TOKEN;
    if (siteID && token) {
          return getStore({ name: STORE_NAME, siteID, token });
    }
    return getStore(STORE_NAME);
}

exports.handler = async (event) => {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    try {
          const store = getBlobStore(event);
          const record = await store.get(KEY, { type: "json" });
          if (!record) {
                  return { statusCode: 200, headers, body: JSON.stringify({ empty: true }) };
          }
          const json = JSON.stringify(record);
          if (json.length > COMPRESS_ABOVE_BYTES) {
                  const gzipBase64 = zlib.gzipSync(json).toString("base64");
                  return { statusCode: 200, headers, body: JSON.stringify({ gzipBase64 }) };
          }
          return { statusCode: 200, headers, body: json };
    } catch (err) {
          return {
                  statusCode: 500,
                  headers,
                  body: JSON.stringify({ error: "Could not read the shared dataset: " + (err && err.message ? err.message : String(err)) }),
          };
    }
};
