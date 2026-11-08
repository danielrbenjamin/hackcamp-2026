# Automatic ML ZIP upload to the Lakehouse

To run the server on another laptop, use [LAPTOP_SETUP.md](LAPTOP_SETUP.md). It includes the local upload tests, guided setup, configuration check and fixed-port launcher.

The implemented path is:

**Stop ML recording → persistent iPhone upload queue → HTTPS upload server → Unity Catalog exports/ → file-arrival job → stage ZIPs → Lakehouse notebook.**

It uses the existing ML ZIP format and flat JSONL metadata. The diagnostic NDJSON recorder is a separate feature. The Lakehouse notebook does not need an NDJSON adapter for this flow.

## 1. Prepare Databricks

Run the setup cells of `lantern_lakehouse.ipynb` so `/Volumes/workspace/default/lantern_walks/exports/` exists.

Give the backend's Databricks identity `USE CATALOG` on `workspace`, `USE SCHEMA` on `workspace.default`, and `READ VOLUME` / `WRITE VOLUME` on `workspace.default.lantern_walks`. Use a service principal with OAuth where available. The job's run identity also needs Volume access and permissions to create/write the existing Lakehouse tables.

Copy the workspace origin, for example `https://<workspace>.cloud.databricks.com`. Keep credentials on the dashboard/server machine only.

## 2. Configure the Windows upload server

Copy `.env.example` to `.env.local` if you do not already have it. Fill in:

```dotenv
# The HTTPS origin forwarding to this Windows dashboard server:
EXPO_PUBLIC_ML_UPLOAD_URL=https://<your-upload-host>
# A separate random demo upload token, shared with the app:
EXPO_PUBLIC_ML_UPLOAD_TOKEN=<demo-upload-token>
# These three values remain SERVER ONLY:
DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
DATABRICKS_CLIENT_ID=<service-principal-client-id>
DATABRICKS_CLIENT_SECRET=<service-principal-oauth-secret>
```

If your workspace cannot issue service-principal credentials, the prototype also accepts a server-only `DATABRICKS_TOKEN` instead of the client ID/secret. Use credentials supported by your workspace; do not embed Databricks tokens in any `EXPO_PUBLIC_` setting or commit `.env.local`.

Start the dashboard server:

```sh
npm ci
npm run lakehouse:start
```

Terminate HTTPS at a trusted reverse proxy/tunnel that forwards to the printed Vite port on this machine. The iPhone must be able to reach the HTTPS URL. The Node endpoint is `PUT /api/ml-recordings/lantern-walk-<UUID>.zip`, with `Content-Type: application/zip` and `Authorization: Bearer <demo-upload-token>`. Keep the server running while uploads are expected.

The endpoint streams each recording to a temporary file and uploads it with Databricks Files API 2.0. ZIPs are stored under `exports/<SHA-256>.zip`; identical retries use the same immutable path. A successful `stored: true` receipt means the ZIP was stored, not that staging or table ingestion has completed. The prototype accepts one upload at a time; other callers retry. Full archive validation happens in the staging task.

This middleware runs under the Vite development server. `npm run build:dashboard` produces static frontend files and does not deploy the upload endpoint. For this prototype, keep the Node/Vite server behind HTTPS; a multi-user production service needs individual authentication and appropriate deployment controls.

## 3. Configure the iPhone

Set `EXPO_PUBLIC_ML_UPLOAD_URL` and `EXPO_PUBLIC_ML_UPLOAD_TOKEN` in the Mac's Expo environment to match the server. Restart Metro with `npm run mobile`; install the current native development build first if ML recording is not available.

On the iPhone, open **Settings → Advanced → Testing and data tools** (or the existing testing/data section), find **ML recording**, and enable **Upload ML recordings automatically**. This explicitly opts in to uploading camera images, depth, pose and model results. It defaults to off on a new installation and is remembered across restarts.

Only recordings stopped while this option is enabled enter the upload queue. Completed ZIPs are copied to the app's documents directory before uploading. Failed uploads remain there, independent of the original temporary ZIP. Retries run every 30 seconds while the app is active and when the app returns to the foreground or restarts. **Retry ML uploads** is also available. Background completion is not guaranteed; reopening the app resumes pending work. Turning the setting off pauses pending uploads and cancels the current request where possible; it cannot recall data already stored by the server. The original manual share action remains available.

## 4. Create the Lakeflow Job

1. Push/import the current `databricks/stage_walk_exports.ipynb` and `databricks/lantern_lakehouse.ipynb` into your Databricks workspace.
2. Open **Jobs & Pipelines → Create job**.
3. Add a notebook task named **stage_ml_zips**, selecting `stage_walk_exports.ipynb` with serverless compute.
4. Add a notebook task named **ingest_lakehouse**, selecting `lantern_lakehouse.ipynb` with serverless compute. Set **Depends on** to **stage_ml_zips** and run it only after successful staging.
5. Set the job's maximum concurrent runs to **1**; enable queuing if offered. Set task retries to **3** for transient failures. This serializes publication and the notebook's table overwrites.
6. Under **Schedules & Triggers**, click **Add trigger → File arrival**.
7. Set the monitored location to `/Volumes/workspace/default/lantern_walks/exports/` without a wildcard. Set **Wait after last change** to **30 seconds** and **Minimum time between triggers** to **60 seconds** for the demo.
8. Click **Test connection**, then **Save**. File-arrival detection is asynchronous; do not expect table updates immediately after stopping a recording.

The staging notebook scans ZIPs, verifies their checksums/format/consent and extracts assets before publishing `incoming/<session>.jsonl`. Receipts are kept outside the watched directory in `upload_receipts/`. Successful archives are skipped on future runs. Invalid archives remain in `exports/` with a `rejected` receipt so one corrupt recording does not block valid sessions. Storage failures fail the task and can be retried. The existing Lakehouse notebook then ingests the flat JSONL records. A retry never overwrites an already-published session with different assets.

If you edit the Python staging modules, regenerate the standalone notebook before pushing:

```sh
python ml/build_stage_notebook.py
```

## 5. End-to-end check

1. Enable auto-upload, record a short ML session and tap **Stop ML recording**. Wait for the upload status.
2. Verify a new SHA-256-named ZIP exists in the Volume's `exports/` directory.
3. Verify the job runs both tasks successfully, that `incoming/<session>.jsonl` exists, and that the session appears in `workspace.default.lantern_silver` and `workspace.default.lantern_sessions`.
4. Disconnect the phone from the network, stop another recording, and confirm the pending count remains nonzero. Restore connectivity and tap **Retry ML uploads**; it should eventually reach zero.
5. Restart the app with a pending ZIP and confirm it is still queued. Disable the setting and confirm no new recording is queued. Rerun the job and confirm existing records are not duplicated.

Local checks:

```sh
npm run typecheck
npm test
npm run build:dashboard
python -m unittest discover -s ml -p test_stage_exports.py -v
```

The local checks use fixtures and mocked Databricks responses. Actual HTTPS reachability, iPhone file persistence/uploads, service-principal permissions and Lakeflow/Delta execution still require the above live test. This automates collection and ingestion; model retraining and model delivery are separate workloads.
