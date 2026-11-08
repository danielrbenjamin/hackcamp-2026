# Lantern

```text
██╗       █████╗  ███╗   ██╗ ████████╗ ███████╗ ██████╗  ███╗   ██╗
██║      ██╔══██╗ ████╗  ██║ ╚══██╔══╝ ██╔════╝ ██╔══██╗ ████╗  ██║
██║      ███████║ ██╔██╗ ██║    ██║    █████╗   ██████╔╝ ██╔██╗ ██║
██║      ██╔══██║ ██║╚██╗██║    ██║    ██╔══╝   ██╔══██╗ ██║╚██╗██║
███████╗ ██║  ██║ ██║ ╚████║    ██║    ███████╗ ██║  ██║ ██║ ╚████║
╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝    ╚═╝    ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝
```

Lantern combines iPhone LiDAR, Google walking routes, and a three-buzzer ESP32 belt. The browser dashboard shows the live scan, hazard overlays, and belt commands. Test warnings while stationary and use a sighted spotter for walking tests.

## Run the demo

Use Node 22.13+ on the 22 line, 24.3+ on the 24 line, or 26+.

```sh
npm ci
npm run dashboard
```

Open the URL Vite prints. Try **Walkway**, **Obstacle**, **Sensor dropout**, and **Crossing person** with **3D scan** and **Plotter** open. The simulator supplies synthetic depth and detections to the guidance code. Model masks and boxes come from the live iPhone. Run `npm run mobile:web` in another terminal to try the app's independent simulator.

## Build for iPhone

1. On a Mac with Xcode 27 and CocoaPods, run `npm ci`. Connect a LiDAR-equipped iPhone running iOS 17 or later. Trust the Mac and enable Developer Mode.
2. For Google routing and place search, enable Navigation SDK for iOS, Maps SDK for iOS, and Places API (New) in a billing-enabled Google Cloud project. Restrict the key to those APIs and to the iOS bundle ID `com.hackcamp2026.navigationbelt`. Copy `.env.example` to `.env.local` and set `GOOGLE_MAPS_IOS_API_KEY` before prebuild. LiDAR and simulation work without the key.
3. Run `npx expo prebuild --platform ios`, then `npm run ios`. Select the connected iPhone. If signing needs setup, open the generated Xcode workspace and select your Apple signing team.
4. Allow camera access. With the phone held forward about 1.2 m above the floor, bring an object within 0.85 m of the phone in the center zone (about ±15°). Verify the warning. Check the zone readings under **Settings → Advanced**.

Rebuild after Swift or model changes. If replacing a model package in an existing iOS project, run `pod install` from `ios/` before rebuilding. Rerun prebuild for changes to the Google key or Expo config. A clean prebuild replaces the generated Xcode project. For JavaScript changes, start Metro with `npm run mobile` and reload the installed development build.

### Set a route

Tap **Speak Destination**, wait for the vibration, and say a place name. The button uses on-device speech recognition and asks for microphone and speech permissions on first use. You can also say **“Hey Siri, navigate with Lantern.”**

For typed entry, press and hold **Settings**, then open **Advanced → Enter destination or change Siri options**. With VoiceOver, focus **Settings** and double-tap. Enable Google Navigation, allow location access, accept Google's terms, choose a suggestion, and tap **Start walk**. **Route options** controls Google spoken directions, manual route-start announcements, and automatic start for spoken routes. Automatic start defaults to off. When enabled, it uses the first Places result. Lantern speaks the destination when a spoken route starts.

Direction cues default to on and require a fresh route and a clear local corridor. The app shows the cue before a belt is connected. Tap **Connect Belt** for buzzer output.

## Connect the dashboard over Tailscale

1. Connect the dashboard computer and iPhone to the same tailnet. On the dashboard computer, run `tailscale serve status`. If its HTTPS root already forwards to port 5173, reuse that address. Otherwise run `tailscale serve --bg http://127.0.0.1:5173`.
2. In `.env.local` on the dashboard computer and in the checkout running Metro, set `EXPO_PUBLIC_TELEMETRY_URL` to the HTTPS origin printed by Serve and set the same `EXPO_PUBLIC_TELEMETRY_TOKEN`. Restart both processes after editing their settings.
3. Run `npm run dashboard` on the dashboard computer. If `npm run lakehouse:start` is already running, it serves the dashboard and upload endpoint on the same port.
4. Open the HTTPS address in your browser. Enter the telemetry token and select **Connect phone feed**. On the iPhone, go to **Settings → Advanced** and enable **Share with dashboard** and **Share 3D scan with dashboard**.

In **3D scan**, switch between **RGB** and **Depth** to recolor the same points. **Front** uses the camera framing. **Orbit** lets you rotate, pan, and zoom. **Fill gaps** uses up to 1.5 seconds of recent returns when tracking is available. **More** contains **Occupancy grid**, **Depth & confidence**, and **Combined overlay**. Drag a tab to an edge to split the workspace, or use **Full screen** on a scan or depth view.

The relay keeps the latest guidance and visual snapshots in memory. Scan sharing includes depth, confidence, sampled color, and relative tracking when available. Full camera frames and raw poses are reserved for local processing and explicit recordings.

## Belt bench test

Flash `firmware/NavigationBelt/NavigationBelt.ino` to a classic ESP32 using Arduino-ESP32 3.x. Wire left to GPIO 25, front to GPIO 33, and right to GPIO 26. With Bluetooth disconnected, use the USB serial monitor at 115200 baud and send `l`, `f`, or `r` to test each buzzer.

- BLE service `08D24000-8CB7-4DAA-AE03-54C7D9655B00`
- Write-without-response characteristic `08D24001-8CB7-4DAA-AE03-54C7D9655B00`
- Packet `[1, cue, farLeft, left, centre, right, farRight]` with strengths from 0 to 255. Cues 0, 1, and 2 mean stop, direction pulse, and rapid warning. Write hex `01 01 00 00 FF 00 00` to test the front buzzer.
- The firmware silences the buzzers on disconnect or after 600 ms without a command. Verify both on the bench. **Sensor to dispatch** measures when the app issues the command. Measure physical buzzer response separately.

## Hazard models

`GlassSegmentation.mlpackage`, `StairSegmentation.mlpackage`, and `PersonDetection.mlpackage` are in `modules/navigation-depth/ios/Models/`. The models run on the iPhone. Google supplies the route heading, and Lantern selects a local direction using LiDAR clearance and the detected hazards.

- Stair and person detections with depth can block directions and trigger the rapid warning. The person tracker projects motion up to 0.6 seconds ahead.
- Glass supplies a bearing. It can block overlapping directions. The rapid warning still requires a separate obstacle cue.
- Raw LiDAR warnings run independently of the models. **Preview hazard models** toggles display and sharing. Hazard inference continues with previews off.

On the dashboard, **Individual models** shows each output. **Combined overlay** puts the masks and boxes on a single depth image. **3D scan overlay** uses the model's matching point cloud. Solid trails show measured pedestrian positions and dashed trails show the forecast. The preview timer measures native processing before upload and rendering. A partial preview can appear at startup. After the first complete frame, the dashboard keeps each complete frame visible until the next one arrives.

## Recordings and Databricks

Under **Settings → Advanced → Session data**, **Export session** shares diagnostic NDJSON with up to 240 records. **Start ML recording** captures up to 120 frames with RGB, depth, pose, and available model outputs. Stop the recording and use **Share ML recording ZIP** or enable automatic uploads.

### Automatic uploads

On Windows, reuse the Tailscale Serve address from the dashboard setup. Stop any standalone dashboard process on port 5173, then run:

```sh
npm run lakehouse:setup
npm run lakehouse:check
npm run lakehouse:start
```

In setup, enter the Databricks workspace origin, the Tailscale HTTPS origin without `/api`, and the Databricks service principal credentials or API token. The upload identity needs `USE CATALOG`, `USE SCHEMA`, and read/write access to the `workspace.default.lantern_walks` Volume. Keep those credentials on Windows.

Copy only `EXPO_PUBLIC_ML_UPLOAD_URL` and `EXPO_PUBLIC_ML_UPLOAD_TOKEN` from the generated `.env.iphone.local` into `.env.local` in the checkout running Metro. Restart Metro, reload Lantern, and turn on **Upload ML recordings automatically** under **Session data**. Stopping a recording queues its ZIP. Failed uploads stay queued. Tap **Retry ML uploads** after reconnecting.

### Lakeflow job

1. Import `databricks/stage_walk_exports.ipynb` and `databricks/lantern_lakehouse.ipynb`. Run the Lakehouse setup cells to create the Volume and tables.
2. Create a job with two notebook tasks. Run `stage_walk_exports.ipynb` first and run `lantern_lakehouse.ipynb` after staging succeeds. Give the job identity access to the Volume and permission to write the Lakehouse tables. Set the maximum concurrent runs to 1.
3. Add a file-arrival trigger for `/Volumes/workspace/default/lantern_walks/exports/`. Record a short session and verify that a ZIP lands in `exports/`, both tasks succeed, and the session appears in `workspace.default.lantern_sessions`. Check `upload_receipts/` for rejected ZIPs.

Run `npm run lakehouse:test` for the local upload tests. If you change the Python staging code, regenerate the staging notebook with `python ml/build_stage_notebook.py`.

### Earlier BEV experiment

The earlier BEV heading model remains in `ml/train.py` and `ml/export_coreml.py`. Its report can be loaded under **Model → Legacy traversability evaluation**. The live selector uses clearance and hazard geometry.

## Checks

```sh
npm run typecheck
npm test
npm run build:dashboard
```

See [AGENTS.md](AGENTS.md) for module boundaries and telemetry details.
