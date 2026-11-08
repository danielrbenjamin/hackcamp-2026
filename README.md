# Lantern

iPhone LiDAR and Google walking directions drive a five-motor ESP32 belt. The dashboard shows scans, guidance, and motor commands.

## Run locally

Use Node 22.13+ on the Node 22 line, Node 24.3+ on the Node 24 line, or Node 26+. Expo SDK 58.0.23 uses React Native 0.88.1.

```sh
npm ci
npm run dashboard
npm run mobile:web
```

Open the URLs printed by Vite and Expo. Try **Obstacle**, **Sensor dropout**, and belt disconnect/reconnect. The **Descending stairs**, **Glass**, and **Crossing person** scenarios inject simulated detections. In the dashboard, use **Guidance** to compare the clearance baseline with the selected heading, **Model** to see blocked headings, and **3D scan** to see located hazards and the pedestrian prediction. The two simulators run independently. Run `npm test`, `npm run typecheck`, and `npm run build:dashboard` to check changes.

## Install and test on an iPhone

1. Transfer the repository to a Mac with Xcode 27 and CocoaPods. Run `npm ci`. Connect a LiDAR-equipped iPhone running iOS 17 or later, trust the Mac, enable Developer Mode, and select your Apple signing team.
2. Enable Navigation SDK for iOS, Maps SDK for iOS, and Places API (New) in a billing-enabled Google Cloud project. Allow those APIs on the key and restrict it to the app's iOS bundle ID. Copy `.env.example` to `.env.local` and set `GOOGLE_MAPS_IOS_API_KEY`. A build without a key can still use simulation and LiDAR.
3. Run `npx expo prebuild --platform ios --clean` to generate the native project, then `npm run ios`. The clean generation replaces root `ios/`. If signing needs manual setup, open the generated Xcode workspace and choose your team before running. Rebuild after changing the key or native code. For JS-only changes, use `npm run mobile`.
4. Lantern starts in LiDAR mode on a development iPhone. Allow camera access and hold the rear camera forward about 1.2 m above the floor. With the tester stationary, bring an object within roughly 0.85 m. Check the warning and the five zone readings under **Settings → Advanced**. Cover or interrupt the sensor and verify directional cues stop. Use **Switch to simulation** in Advanced to try the mock scenarios.
5. Validate mounting, compass alignment, and depth coverage. Direction cues are enabled by default and require a fresh route and observed clearance. They appear on screen even with the belt disconnected. Tap **Connect belt** to receive them on the hardware, or turn off **Direction cues** to keep obstacle warnings only.
6. Tap **Enable Google Navigation**, grant location access, and accept the Google dialog. Type or dictate a place name or address, select a suggestion, then tap **Start walk**. Verify the destination, maneuver text, and rerouting on the route card. Google turn-by-turn audio and route-start announcements for manually entered routes are off by default. Use **Route options** to enable either, or choose **Enter coordinates or Place ID** for manual entry.

Google Navigation 0.19.0 autolinks the iOS SDK. The local Expo plugin initializes the key in the generated Swift AppDelegate and adds the SDK's location and audio background modes. Run prebuild and reinstall the app to apply these native settings. [Expo SDK 58](https://expo.dev/changelog/sdk-58) · [Google’s Expo guide](https://github.com/googlemaps/react-native-navigation-sdk/blob/main/EXPO.md)

### Siri

On the iPhone, tap **Speak Destination**, wait for the vibration, then say a place name or address. The first use requests microphone and speech recognition permissions. Lantern uses on-device recognition for this button. You can also say **“Hey Siri, navigate with Lantern”** or invoke Siri with the side button. Typed entry and **Start spoken routes automatically** are under **Settings → Advanced → Enter destination or change Siri options → Route options**. Automatic start selects the first Google Places suggestion and defaults to off. Lantern speaks the selected destination when a spoken route starts. The first route may require location permission and Google’s terms. End an active route before requesting another one.

## Belt bench test

The sample sketch in `firmware/NavigationBelt/` targets a classic ESP32 with Arduino-ESP32 3.x. Confirm the five output pins with the hardware teammate and connect them to motor drivers. Flash the sketch, then tap **Connect belt** on the iPhone. The protocol is also usable from a BLE test client.

- Service `08D24000-8CB7-4DAA-AE03-54C7D9655B00`
- Write-without-response characteristic `08D24001-8CB7-4DAA-AE03-54C7D9655B00`
- Seven bytes `[version=1, cue, farLeft, left, centre, right, farRight]`. Strengths are 0–255. Cue 0 stops, 1 pulses one or more outputs, and 2 repeats a rapid obstacle alert (75 ms on, 65 ms off). To check the centre output, write hex `01 01 00 00 FF 00 00`. Test each channel in order.
- The phone refreshes active commands about every 200 ms. The firmware shuts the motors off on disconnect or after 600 ms without a command. The phone reads optional standard battery service `180F`, characteristic `2A19`, when provided by the belt.

Trigger an obstacle while a directional cue is active, disconnect and reconnect, and verify motor shutoff on loss of the link. The dashboard reports capture-to-command-dispatch timing. Measure obstacle-to-motor timing separately on the bench.

## Phone telemetry and recordings

For opt-in automatic **ML recording ZIP** uploads to Databricks and a two-task file-arrival job, follow [the Lakehouse upload setup](databricks/UPLOAD_SETUP.md). This uses the existing ZIP/JSONL format and is separate from diagnostic NDJSON exports.

To run the dashboard/upload server on another laptop, follow [the laptop setup guide](databricks/LAPTOP_SETUP.md). After `npm ci`, run `npm run lakehouse:test`, then `npm run lakehouse:setup` and `npm run lakehouse:start`.

On the phone, press and hold **Settings** and choose **Advanced** for dashboard sharing and session recording. With VoiceOver, focus **Settings** and double-tap.

With **Share 3D scan with dashboard** on, **Depth & confidence** shows distance and confidence from the same ARKit frame. Switch between **Raw** and **Smoothed** when available, and point at either image to read a pixel's distance and confidence. **Color range** controls display contrast. The 3D preview draws every finite positive sample in the ARKit depth raster, including low-confidence samples, with camera colors where available. **Front** uses the original camera framing, and **Orbit** lets you adjust rotation and tilt. Belt guidance continues to use its own range and confidence checks. Full RGB camera frames stay on-device.

The live **3D scan** has **Fill gaps** on by default when the phone supplies ARKit tracking data. Move the phone slowly to observe the same surface from slightly different angles. The dashboard aligns returns from up to 1.5 seconds of recent frames and draws them only where the current frame has no depth. Turn **Fill gaps** off to compare against the current frame. Moving objects can leave brief traces. Model overlays use the frame that produced each prediction.

Drag a dashboard tab to an edge of the editor to split the workspace. The tab bar also has **Split right** and **Split down** controls. Drag the divider to resize the panes or focus it and use the arrow keys. Drag a tab onto the other pane's tab bar to move it, or use the pane's close button to merge the tabs again.

- For a local dashboard feed, set `EXPO_PUBLIC_TELEMETRY_URL` to a reachable local hostname such as `http://laptop.local:5173` and set the same `EXPO_PUBLIC_TELEMETRY_TOKEN` for Expo and Vite. Run `npm run dashboard -- --host 0.0.0.0` on a trusted demo LAN. In the dashboard enter the token and click **Connect phone feed**. On the phone choose **Share with dashboard**. To see actual LiDAR points, choose **iPhone LiDAR** and **Share 3D scan with dashboard**, then select **3D scan** in the dashboard. Rebuild the iPhone app to pick up the native preview support. The scan shows the current frame, with color indicating height relative to the phone. The relay keeps only the latest frame in memory and excludes raw depth images, RGB, pose, and destination text.
- For diagnostics, choose **Start recording**, stop the session, then choose **Export session**. Each export contains up to 240 NDJSON records. Real sessions capture downsampled depth, confidence, intrinsics, pose, BEV, and navigation/reflex decisions with aligned timestamps.
- For the Lakehouse, select **Use iPhone LiDAR** and **Start ML recording** under **Session data**. Walk with consent, choose **Stop ML recording**, then **Share ML recording ZIP**. The app captures up to 120 frames at intervals of at least one second, with inference and file writes off the guidance queue. Camera images and training data stay local until shared.

## Hazard models

Google computes the walking route. Lantern tests nine local corridors from −60° to +60° against LiDAR clearance and frame-aligned hazard detections, then favors directions that follow the route and stay consistent with the previous cue. If hazards eliminate all eligible directions, Lantern withholds the direction cue. The raw LiDAR reflex continues to handle immediate obstacles.

The three selected packages, `GlassSegmentation.mlpackage`, `StairSegmentation.mlpackage`, and `PersonDetection.mlpackage`, belong in `modules/navigation-depth/ios/Models/` and can be tracked by Git. If the iOS project already exists, run `pod install` from root `ios/` to update its model resources, then run `npm run ios` from the repo root.

Hazard models start in iPhone LiDAR mode. **Preview hazard models** under **Settings → Advanced** controls the diagnostic preview and its sharing. With dashboard and 3D scan sharing enabled, use the **Combined overlay**, **Individual models**, or **3D scan overlay** tab.

Fresh model hazards can block a local direction and trigger the belt obstacle pattern when they overlap the forward corridor. Stairs require depth-supported mask points. People use measured positions and a short crossing forecast. Glass uses its image bearing with distance unknown. The phone discards old results and clears them when tracking resets. The independent raw LiDAR warning has priority and continues if models are unavailable. Check the model warning transitions and false alerts on a stationary iPhone before walking with the belt.

**Combined overlay** shows all three model outputs on one depth image. **3D scan overlay** adds the projected detections to the colored point cloud captured with the model frame. Both views use the matching scan even while the live view advances.

Glass uses the supplied ImageNet and valid-depth p99 transform. The stair preview preserves camera aspect ratio with zero padding, then uses 384 × 384 bilinear sampling, ImageNet RGB normalization, and valid-depth p1/p99 clipping followed by `(depth - 0.5) / 0.25` after scaling depth to 0–1. Sampled training images confirm that larger encoded values represent farther surfaces, as with iPhone depth in metres. A depth return within a glass mask may belong to the background. Pedestrian trajectories use short-range nearest-neighbor association in ARKit world coordinates and a 0.6-second constant-velocity prediction. Verify model alignment, false detections, and latency on a stationary iPhone before any navigation integration.

In **3D scan overlay**, solid green trails show up to eight recent measured person positions. Dashed orange trails show predictions at +200, +400 and +600 ms. Front projects trails into the matching camera frame, and Orbit shows them in 3D. Tracks can survive a brief missed detection and reset when ARKit loses tracking. Check that a stationary person's trail stays in place while moving the phone, then check a walking person and a tracking interruption.

### Earlier traversability experiment

### Lakehouse walk ingestion

On Databricks, upload the consented ZIP to `/Volumes/workspace/default/lantern_walks/exports/`. Run `ml/stage_walk.py` from the workspace repo with the ZIP's full volume path as its only argument, or import `stage_walk` and call it from a notebook. This stages the assets and publishes the frame JSONL under `incoming/` last. Run `databricks/lantern_lakehouse.ipynb` through the team's Lakeflow Job and check the frame count in `workspace.default.lantern_sessions`. Rerun the same input to verify Bronze and Silver counts stay stable.

The ZIP contains camera-native JPEGs, row-major little-endian Float32 depth in metres (zero means invalid), and row-major UInt8 ARKit confidence when available. Mask files contain row-major class labels in camera-image coordinates at 224 × 224 for glass or 384 × 384 for stairs. The staging script also accepts older 96 × 96 masks. Each model's score is the maximum sampled sigmoid or softmax class probability in the frame. Missing model results are omitted. Pedestrian positions are in ARKit world coordinates, and track IDs reset when tracking is reset. Extra fields such as raster dimensions and confidence paths are retained in Bronze raw JSON.

The ML teammate can upload consented exports to an authorized Databricks Volume and run `ml/train.py` as a Python script task on a Databricks ML runtime with PySpark, PyTorch, NumPy, and MLflow 3. Pass the input path and `--experiment /Shared/navigation-belt`. At least two independent LiDAR sessions are needed. The job deduplicates frames, generates geometric candidate labels, trains with sessions held out, compares against a short-clearance baseline, and logs a versioned model and `evaluation.json`. Load that report in the dashboard. `--register-candidate catalog.schema.model` optionally registers a candidate in Unity Catalog.

The earlier export script, `ml/export_coreml.py MODEL_URI VERSION`, checks Core ML predictions against PyTorch and writes `Traversability.mlpackage`. The app's direction selector now uses clearance and hazard detections instead of those heading scores.

The training labels are geometric candidates. Evaluate against independently reviewed outcomes before relying on a model in the field. See [AGENTS.md](AGENTS.md) for interface details.
