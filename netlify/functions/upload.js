// POST /api/upload  ->  /.netlify/functions/upload
// Body: { password, fileName, missingColumns, rows }
// Checks the shared password (set as the UPLOAD_PASSWORD environment
// variable in Netlify — see DEPLOY.md) and, if it matches, overwrites the
// single shared dataset everyone else reads from /api/data.
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "meesho-elasticrun-dashboard";
const KEY = "current";
const MAX_ROWS = 200000; // sanity ceiling — the 4500 report is a few thousand rows

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed — use POST." }) };
  }

  const expected = process.env.UPLOAD_PASSWORD;
  if (!expected) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "The server has no UPLOAD_PASSWORD configured. Add it in Netlify: Site configuration → Environment variables, then redeploy.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  if (typeof payload.password !== "string" || payload.password !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong upload password." }) };
  }

  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No rows to upload." }) };
  }
  if (payload.rows.length > MAX_ROWS) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Too many rows (${payload.rows.length}) — this exceeds the ${MAX_ROWS} sanity limit.` }) };
  }

  const record = {
    fileName: String(payload.fileName || "uploaded-report").slice(0, 300),
    uploadedAt: new Date().toISOString(),
    rowCount: payload.rows.length,
    missingColumns: Array.isArray(payload.missingColumns) ? payload.missingColumns : [],
    rows: payload.rows,
  };

  try {
    if (event && event.blobs) connectLambda(event);
    const store = getStore(STORE_NAME);
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
