// GET /api/data  ->  /.netlify/functions/data
// Returns the currently-stored shared dataset (or { empty: true } if nobody
// has uploaded one yet). Read-only, no password required — viewing the
// dashboard is open to anyone with the link.
const { connectLambda, getStore } = require("@netlify/blobs");

const STORE_NAME = "meesho-elasticrun-dashboard";
const KEY = "current";

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  try {
    if (event && event.blobs) connectLambda(event);
    const store = getStore(STORE_NAME);
    const record = await store.get(KEY, { type: "json" });
    if (!record) {
      return { statusCode: 200, headers, body: JSON.stringify({ empty: true }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(record) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Could not read the shared dataset: " + (err && err.message ? err.message : String(err)) }),
    };
  }
};
