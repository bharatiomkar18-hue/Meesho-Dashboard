# Deploying the shared Meesho × ElasticRun dashboard

This turns the dashboard into a normal website: one URL, hosted on Netlify,
that everyone on your team can open. Whoever uploads the 4500 report last
is what everyone else sees — the data is stored server-side (in Netlify
Blobs), not just in the uploader's own browser.

## What's in this folder

- `public/` — the website itself (HTML/CSS/JS). Netlify serves this as-is.
- `netlify/functions/data.js` — read endpoint. Anyone can call this (it's
  how every viewer's page loads the current shared dataset).
- `netlify/functions/upload.js` — write endpoint. Requires a password
  (see step 3) before it will overwrite the shared dataset.
- `netlify.toml` — tells Netlify where the site and functions live, and
  maps the friendly `/api/data` and `/api/upload` paths to them.
- `test/` — a local-only test harness (not part of the deployed site).
  Safe to ignore or delete.

## 1. Push this to GitHub

```bash
cd dashboard-hosted
git init                      # if you haven't already
git add .
git commit -m "Shared Meesho x ElasticRun dashboard"
git branch -M main
git remote add origin https://github.com/<your-org>/<your-repo>.git
git push -u origin main
```

(If you'd rather use GitHub's website: create a new empty repository there,
then follow the "push an existing repository" instructions it shows you.)

## 2. Connect the repo to Netlify

1. Log in at [app.netlify.com](https://app.netlify.com).
2. **Add new site → Import an existing project → Deploy with GitHub**, and
   authorize Netlify to see your GitHub account if asked.
3. Pick the repository you just pushed.
4. Build settings: Netlify should auto-detect everything from
   `netlify.toml` (publish directory `public`, functions directory
   `netlify/functions`). You don't need to type anything into the build
   command field — leave it blank, there's no build step.
5. Click **Deploy site**. The first deploy will fail to actually work yet
   (no password configured) — that's expected, fix it in the next step.

## 3. Add the shared upload password (the "token" step)

This is the one environment variable you must add by hand:

1. In your new Netlify site, go to **Site configuration → Environment
   variables → Add a variable**.
2. Key: `UPLOAD_PASSWORD`
3. Value: `Cops@2026!` (the password you chose — change it here any time
   without touching code; just redeploy after changing it).
4. Scope: leave it applied to all deploy contexts (Production is what
   matters).
5. Save, then go to **Deploys** and click **Trigger deploy → Deploy site**
   so the new function picks up the variable (Netlify Functions read
   environment variables at deploy time, so a plain redeploy is needed
   after adding or changing this one).

That's normally the only secret this project needs. **Netlify Blobs — the
storage that holds the uploaded dataset — usually needs no separate token
or account.** When your `data.js` / `upload.js` functions run on Netlify's
own infrastructure, they automatically get permission to read/write your
site's Blob store, with nothing else to add under Environment variables.

### If you see a Blobs error anyway (e.g. "MissingBlobsEnvironmentError")

Some deploy setups — a manual/drag-and-drop deploy instead of a
GitHub-linked one, certain CI pipelines, or self-hosted/Enterprise
Netlify — don't automatically inject Blobs access into the functions.
`data.js` and `upload.js` both fall back to using an explicit Site ID and
token if you provide them, so add these two extra environment variables
the same way you added `UPLOAD_PASSWORD` above:

1. **Key:** `BLOBS_SITE_ID` — **Value:** your Site ID, found at
   **Site configuration → General → Site details → Site ID**.
2. **Key:** `BLOBS_TOKEN` — **Value:** a Personal Access Token, created at
   **Netlify → User settings → Applications → New access token** (give it
   a name like "dashboard blobs access"; copy the token immediately, it's
   only shown once).
3. Save both, then **Deploys → Trigger deploy → Deploy site** so the
   functions pick them up.

Treat `BLOBS_TOKEN` like a password — it grants read/write access to your
Netlify account's storage, so only add it as an environment variable
(never commit it to the repo).

If `data.js`/`upload.js` work fine without these two variables, there's no
need to add them — the automatic wiring is already handling it.

## 4. Try it

Open your new Netlify URL (something like `random-name-123.netlify.app` —
you can rename it under **Site configuration → General → Site details →
Change site name**, or attach a real domain there too).

- First visit: you'll see "No shared report uploaded yet."
- Click **Choose file**, pick the 4500 report, enter `Cops@2026!` when
  asked, and click **Upload & share**.
- Open the same URL in another browser (or send the link to a colleague):
  they should see the exact same dashboard, without uploading anything
  themselves.
- The **↻ Refresh** button in the topbar re-pulls the shared data — useful
  if you already had a tab open when someone else uploaded a newer file.

## Who can do what

- **Viewing** the dashboard is open to anyone with the link — no password.
- **Uploading** (replacing what everyone sees) requires the shared
  password from step 3. Change that password any time by editing the
  `UPLOAD_PASSWORD` environment variable and redeploying — this instantly
  locks out anyone who only knew the old one.
- There's no per-person login and no audit trail of who uploaded what.
  If you need to know exactly who uploaded a given file, that's a bigger
  change (real user accounts) — let me know if that becomes a real need
  and we can add it.

## A few practical limits worth knowing

- The shared dataset is a **single snapshot** — uploading replaces it for
  everyone. There's no history of older uploads kept anywhere.
- Rows are stored as JSON, not as the original Excel file. This keeps
  things fast (no re-parsing a spreadsheet on every page load) but means
  the original `.xlsx` isn't retrievable afterwards — only the data the
  dashboard actually reads from it.
- Comfortably handles reports up to tens of thousands of rows. If a future
  report gets dramatically larger (hundreds of thousands of rows), the
  upload may need chunking — not a concern at the 4500-report's current
  scale (a few thousand rows).
- If two people upload within moments of each other, the second upload
  simply wins — there's no merge or conflict warning.

## Local testing (optional)

`netlify dev` normally lets you run the whole site (including the
Functions) on your own machine before pushing. In this sandboxed
environment it couldn't finish setting up because outbound access to
Netlify's edge-functions download was blocked — that's specific to this
sandbox, not your machine. On your own computer, with `netlify-cli`
installed (`npm install -g netlify-cli`) and normal internet access, this
should work directly:

```bash
npm install
netlify link      # first time only — connects this folder to your Netlify site
netlify dev
```

Everything else here (the actual function logic, the password gate, and
the full upload → shared-view → refresh flow) was tested end-to-end using
a small local mock of Netlify Blobs — see `test/mock-server.js` if you
want to rerun that yourself; it's a stand-in for Blobs, not Netlify's real
storage, but it exercises the exact same function code that will run in
production.
