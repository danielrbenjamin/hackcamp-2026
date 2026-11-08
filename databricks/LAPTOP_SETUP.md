# Run Lantern's Lakehouse uploader on a laptop

The uploader runs alongside the dashboard. Databricks stores the ZIPs and runs the already-configured file-arrival job. This guide works on Windows; the npm commands also work on Mac.

## Prerequisites

- The pushed `lakehousebetter` branch, including the new setup scripts and upload files.
- The Databricks workspace HTTPS origin, with no notebook path or URL query string.
- An authorized service-principal client ID and OAuth secret, or a supported API token for the prototype, provided privately. Use an identity with access to the same Volume. Never commit credentials.
- Confirmation that the existing two-task Databricks job watches `/Volumes/workspace/default/lantern_walks/exports/`. It must stage ZIPs before running the Lakehouse notebook. There is no need to recreate the job on each laptop.

## First-time laptop setup

Install a supported Node version first: Node 22.13+ on the 22 line, Node 24.3+ on the 24 line, or Node 26+.

Use a fresh checkout if you want to avoid affecting existing local work:

```sh
git clone --branch lakehousebetter https://github.com/danielrbenjamin/hackcamp-2026.git lantern-upload
cd lantern-upload
npm ci
npm run lakehouse:test
```

If the repo is already checked out, switch to `lakehousebetter` and pull it using your normal Git workflow. Keep local work before switching; no force reset is needed. `lakehouse:test` checks the upload queue, server handler, credential handling and setup wizard using local fixtures. It does not contact Databricks or upload any data.

## Start the HTTPS tunnel

In a terminal at the repository root:

```sh
npx wrangler tunnel quick-start http://localhost:5173
```

Accept the package installation prompt if shown. Copy the printed `https://...trycloudflare.com` address and keep this terminal running. The address will not serve the dashboard until the server starts in the next step. The temporary hostname changes when you restart the tunnel.

For a stable tunnel or an existing HTTPS reverse proxy, use its origin instead. The example Quick Tunnel is only for the prototype. Start with a short recording; your HTTPS provider may impose request-size limits on larger ZIPs.

## Configure and start the server

Open a second terminal in the same repository folder:

```sh
npm run lakehouse:setup
```

The wizard asks for:

1. Databricks workspace HTTPS origin.
2. The HTTPS tunnel origin from the first terminal, without `/api`.
3. Authentication method: **1** for OAuth client ID/secret, or **2** for an existing supported API token.
4. The chosen credentials. Secret inputs are hidden and are not printed afterward.

It creates a separate random upload token automatically and saves everything to ignored `.env.local`, preserving other settings. On subsequent runs, press Enter to retain values; enter a new tunnel URL when it changes.

Then run:

```sh
npm run lakehouse:check
npm run lakehouse:start
```

The check validates configuration syntax, not remote permissions. The launcher starts the dashboard and upload endpoint together on port **5173**. If that port is busy, stop the other dashboard process; the launcher deliberately does not switch to another port and break the tunnel.

Keep BOTH the tunnel and server terminals running. The dashboard browser tab itself can be closed.

## Connect the iPhone's Mac

The wizard also writes ignored `.env.iphone.local`. It contains ONLY:

```dotenv
EXPO_PUBLIC_ML_UPLOAD_URL=https://<the-current-tunnel-host>
EXPO_PUBLIC_ML_UPLOAD_TOKEN=<the-generated-upload-token>
```

Copy those two settings into the Mac Expo project's `.env.local`, preserving Google and other settings. Do not copy the complete server `.env.local` to the iPhone project. If Expo runs from this same laptop, the settings are already present there.

Restart Metro with `npm run mobile`, reload the iPhone app and enable **Upload ML recordings automatically** under ML recording. When the tunnel URL changes, rerun setup and update/reload the app with the new public URL. Keep the generated upload token consistent across the server and app.

## Verify once

1. Make a short ML recording and tap **Stop ML recording**.
2. Confirm the phone reports a successful upload and zero pending ZIPs.
3. In Databricks, confirm a new ZIP appears under the Volume's `exports/` directory.
4. Confirm the existing file-arrival job runs both tasks and the session appears in `lantern_sessions`.
5. Test once offline: stop a recording with no network, restore connectivity, and tap **Retry ML uploads**. The queued ZIP should survive until it is acknowledged.

If uploading fails, check the host/token, server and tunnel processes, Databricks credential validity and Volume permissions. An uploaded ZIP with no job run points to the trigger; a rejected ZIP has a receipt under `upload_receipts/`. Do not post private Databricks credentials in screenshots or chat.

The application retries while active and after reopening, with persistent queued files. It does not guarantee background uploads after iOS suspends it. This flow uploads and ingests recordings; it does not automatically retrain or replace iPhone models.
