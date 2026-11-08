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
4. Try simulation first. Then tap **Use iPhone LiDAR**, allow camera access, and hold the rear camera forward about 1.2 m above the floor. With the tester stationary, bring an object within roughly 0.85 m. Check the warning and the five zone readings under **Testing and data tools**. Cover or interrupt the sensor and verify directional cues stop.
5. Validate mounting, compass alignment, and depth coverage. Direction cues are enabled by default and require a fresh route and observed clearance. They appear on screen even with the belt disconnected. Tap **Connect belt** to receive them on the hardware, or turn off **Direction cues** to keep obstacle warnings only.
6. Tap **Enable Google Navigation**, grant location access, and accept the Google dialog. Type or dictate a place name or address, select a suggestion, then tap **Start walk**. Verify the destination, maneuver text, and rerouting on the route card. Google turn-by-turn audio and route-start announcements for manually entered routes are off by default. Use **Route options** to enable either, or choose **Enter coordinates or Place ID** for manual entry.

Google Navigation 0.19.0 autolinks the iOS SDK. The local Expo plugin initializes the key in the generated Swift AppDelegate and adds the SDK's location and audio background modes. Run prebuild and reinstall the app to apply these native settings. [Expo SDK 58](https://expo.dev/changelog/sdk-58) · [Google’s Expo guide](https://github.com/googlemaps/react-native-navigation-sdk/blob/main/EXPO.md)

### Siri

After rebuilding, say **“Hey Siri, navigate with Lantern”** and answer with a place name or address. Under **Walking directions → Route options**, enable **Start Siri routes automatically** to start a walk to the first Google Places suggestion. The switch defaults to off. Lantern speaks the selected destination when a Siri route starts, including when you choose a result manually. The first run may require location permission and Google’s terms. Stop any active route before requesting another destination with Siri.

## Belt bench test

The sample sketch in `firmware/NavigationBelt/` targets a classic ESP32 with Arduino-ESP32 3.x. Confirm the five output pins with the hardware teammate and connect them to motor drivers. Flash the sketch, then tap **Connect belt** on the iPhone. The protocol is also usable from a BLE test client.

- Service `08D24000-8CB7-4DAA-AE03-54C7D9655B00`
- Write-without-response characteristic `08D24001-8CB7-4DAA-AE03-54C7D9655B00`
- Seven bytes `[version=1, cue, farLeft, left, centre, right, farRight]`. Strengths are 0–255. Cue 0 stops, 1 pulses one or more outputs, and 2 repeats a rapid obstacle alert (75 ms on, 65 ms off). To check the centre output, write hex `01 01 00 00 FF 00 00`. Test each channel in order.
- The phone refreshes active commands about every 200 ms. The firmware shuts the motors off on disconnect or after 600 ms without a command. The phone reads optional standard battery service `180F`, characteristic `2A19`, when provided by the belt.

Trigger an obstacle while a directional cue is active, disconnect and reconnect, and verify motor shutoff on loss of the link. The dashboard reports capture-to-command-dispatch timing. Measure obstacle-to-motor timing separately on the bench.

## Phone telemetry and recordings

On the phone, open **Testing and data tools** for dashboard sharing and session recording.

For a wider scan, turn on **Share 3D scan with dashboard**, open **3D scan**, then select **Room scan** and pan slowly. This opt-in sends scan-relative position and yaw along with the points. The browser combines frames into a temporary map. Use **Live** for the current frame or **Clear scan** to start over.

With scan sharing on, **Depth & confidence** shows two live sensor images from the same ARKit frame. The distance image covers returns up to 5 m. Use **Color range** to increase contrast at shorter distances. The confidence image shows ARKit's low, medium, and high confidence levels. Black pixels have no in-range return. The 3D views use a sampled camera color for each shared point when available. Use **Front** for a straight-on view or **Orbit** to adjust rotation and tilt. Full RGB camera frames stay on-device.

- For a local dashboard feed, set `EXPO_PUBLIC_TELEMETRY_URL` to a reachable local hostname such as `http://laptop.local:5173` and set the same `EXPO_PUBLIC_TELEMETRY_TOKEN` for Expo and Vite. Run `npm run dashboard -- --host 0.0.0.0` on a trusted demo LAN. In the dashboard enter the token and click **Connect phone feed**. On the phone choose **Share with dashboard**. To see actual LiDAR points, choose **iPhone LiDAR** and **Share 3D scan with dashboard**, then select **3D scan** in the dashboard. Rebuild the iPhone app to pick up the native preview support. The scan shows the current frame, with color indicating height relative to the phone. The relay keeps only the latest frame in memory and excludes raw depth images, RGB, pose, and destination text.
- For training data, choose **Start recording**, stop the session, then choose **Export session**. Each export contains up to 240 NDJSON records. Real sessions capture downsampled depth, confidence, intrinsics, pose, BEV, and navigation/reflex decisions with aligned timestamps. Exported sessions are kept separate from the live relay.

## Hazard models

Google computes the walking route. Lantern tests nine local corridors from −60° to +60° against LiDAR clearance and frame-aligned hazard detections, then favors directions that follow the route and stay consistent with the previous cue. If hazards eliminate all eligible directions, Lantern withholds the direction cue. The raw LiDAR reflex continues to handle immediate obstacles.

The app and dashboard accept simulated stair, glass, and pedestrian detections. Live iPhone mode uses the clearance baseline while the three Core ML packages and their input/output specifications are pending. Existing session exports contain depth and pose. Training with camera frames requires a separate consented RGB export.

Model adapters should attach detections to the matching observation in `shared/contracts.ts`. Use phone-relative metres for a located hazard and a bearing range when depth is unavailable. For a person, an optional predicted position is the end of a short path in the same coordinate frame. Reproject delayed detections into the current observation before using them. Only opt-in 3D scan sharing sends hazard locations to the dashboard.

### Earlier traversability experiment

The ML teammate can upload consented exports to an authorized Databricks Volume and run `ml/train.py` as a Python script task on a Databricks ML runtime with PySpark, PyTorch, NumPy, and MLflow 3. Pass the input path and `--experiment /Shared/navigation-belt`. At least two independent LiDAR sessions are needed. The job deduplicates frames, generates geometric candidate labels, trains with sessions held out, compares against a short-clearance baseline, and logs a versioned model and `evaluation.json`. Load that report in the dashboard. `--register-candidate catalog.schema.model` optionally registers a candidate in Unity Catalog.

The earlier export script, `ml/export_coreml.py MODEL_URI VERSION`, checks Core ML predictions against PyTorch and writes `Traversability.mlpackage`. The app's direction selector now uses clearance and hazard detections instead of those heading scores.

The training labels are geometric candidates. Evaluate against independently reviewed outcomes before relying on a model in the field. See [AGENTS.md](AGENTS.md) for interface details.
