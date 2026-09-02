// POST /api/upload  ->  /.netlify/functions/upload
// Body: { password, fileName, missingColumns, rows }
// Checks the shared password (set as the UPLOAD_PASSWORD environment
// variable in Netlify, see DEPLOY.md) and, if it matches, overwrites the
// single shared dataset everyone else reads from /api/data.
const { connectLambda, getStore } = require("@netlify/blobs");
const zlib = require("zlib");

const STORE_NAME = "meesho-elasticrun-dashboard";
const KEY = "current";
const MAX_ROWS = 200000;

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
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed, use POST." }) };
  }

  const expected = process.env.UPLOAD_PASSWORD;
  if (!expected) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "The server has no UPLOAD_PASSWORD configured. Add it in Netlify: Site configuration -> Environment variables, then redeploy.",
      }),
    };
  }

  // Large reports are sent gzip-compressed and base64-wrapped by the
  // browser (see gzipBase64JSON in app3.js) to stay well under Netlify
  // Functions' ~6 MB request-body limit. Older browsers without
  // compression support just send plain JSON, handled the same as before.
  let payload;
  try {
    const raw = JSON.parse(event.body || "{}");
    if (raw && typeof raw.gzipBase64 === "string") {
      const json = zlib.gunzipSync(Buffer.from(raw.gzipBase64, "base64")).toString("utf8");
      payload = JSON.parse(json);
    } else {
      payload = raw;
    }
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid or corrupt upload body: " + (e && e.message ? e.message : String(e)) }) };
  }

  if (typeof payload.password !== "string" || payload.password !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong upload password." }) };
  }

  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No rows to upload." }) };
  }
  if (payload.rows.length > MAX_ROWS) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Too many rows (${payload.rows.length}), this exceeds the ${MAX_ROWS} sanity limit.` }) };
  }

  const record = {
    fileName: String(payload.fileName || "uploaded-report").slice(0, 300),
    uploadedAt: new Date().toISOString(),
    rowCount: payload.rows.length,
    missingColumns: Array.isArray(payload.missingColumns) ? payload.missingColumns : [],
    rows: payload.rows,
  };

  try {
    const store = getBlobStore(event);
    await store.setJSON(KEY, record);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, uploadedAt: record.uploadedAt, rowCount: record.rowCount }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Could not save the shared dataset: " + (err && err.message ? err.message : String(err)) }),
    };
  }
};
