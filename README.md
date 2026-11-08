# Lantern

iPhone LiDAR and Google walking directions drive a five-motor ESP32 belt. The dashboard shows scans, guidance, and motor commands.

## Run locally

Use Node 22.13+ on the Node 22 line, Node 24.3+ on the Node 24 line, or Node 26+. Expo SDK 58.0.23 uses React Native 0.88.1.

```sh
npm ci
npm run dashboard
npm run mobile:web
```

Open the URLs printed by Vite and Expo. Try **Obstacle**, **Dropout**, and belt disconnect/reconnect. The two simulators run independently. Run `npm test`, `npm run typecheck`, and `npm run build:dashboard` to check changes.

## Install and test on an iPhone

1. Transfer the repository to a Mac with Xcode 27 and CocoaPods. Run `npm ci`. Connect a LiDAR-equipped iPhone running iOS 17 or later, trust the Mac, enable Developer Mode, and select your Apple signing team.
2. Enable Navigation SDK for iOS, Maps SDK for iOS, and Places API (New) in a billing-enabled Google Cloud project. Allow those APIs on the key and restrict it to the app's iOS bundle ID. Copy `.env.example` to `.env.local` and set `GOOGLE_MAPS_IOS_API_KEY`. A build without a key can still use simulation and LiDAR.
3. Run `npx expo prebuild --platform ios --clean` to generate the native project, then `npm run ios`. The clean generation replaces root `ios/`. If signing needs manual setup, open the generated Xcode workspace and choose your team before running. Rebuild after changing the key or native code. For JS-only changes, use `npm run mobile`.
4. Try **Simulation** first. Then tap **iPhone LiDAR**, allow camera access, and hold the rear camera forward about 1.2 m above the floor. With the tester stationary, bring an object within roughly 0.85 m. Check the warning and the five zone readings under **Testing and data tools**. Cover or interrupt the sensor and verify directional cues stop.
5. Tap **Enable Google Navigation**, grant location access, and accept the Google dialog. Type or dictate a place name or address, select a suggestion, then tap **Start walk**. For manual entry, open **Route options** and choose **Enter coordinates or Place ID**. Verify the destination, maneuver text, and rerouting on the route card. Native directional cues start disabled. Enable them under **Testing and data tools** only after validating mounting, compass alignment, and depth coverage.

Google Navigation 0.19.0 autolinks the iOS SDK. The local Expo plugin initializes the key in the generated Swift AppDelegate and adds the SDK's location and audio background modes. Run prebuild and reinstall the app to apply these native settings. [Expo SDK 58](https://expo.dev/changelog/sdk-58) · [Google’s Expo guide](https://github.com/googlemaps/react-native-navigation-sdk/blob/main/EXPO.md)

### Siri

After rebuilding, say **“Hey Siri, navigate with Lantern”** and answer with a place name or address. Under **Walking directions → Route options**, enable **Start Siri routes automatically** to start a walk to the first Google Places suggestion. Lantern reads the selected destination aloud once walking guidance starts. The switch defaults to off. The first run may require location permission and Google’s terms. Stop any active route before requesting another destination with Siri.

## Belt bench test

The sample sketch in `firmware/NavigationBelt/` targets a classic ESP32 with Arduino-ESP32 3.x. Confirm the five output pins with the hardware teammate and connect them to motor drivers. Flash the sketch, then tap **Scan for physical belt** on the iPhone. The protocol is also usable from a BLE test client.

- Service `08D24000-8CB7-4DAA-AE03-54C7D9655B00`
- Write-without-response characteristic `08D24001-8CB7-4DAA-AE03-54C7D9655B00`
- Seven bytes `[version=1, cue, farLeft, left, centre, right, farRight]`. Strengths are 0–255. Cue 0 stops, 1 pulses one or more motors, and 2 gives a distinct double pulse. To check the centre motor, write hex `01 01 00 00 FF 00 00`. Test each channel in order.
- The phone refreshes active commands about every 200 ms. The firmware shuts the motors off on disconnect or after 600 ms without a command. The phone reads optional standard battery service `180F`, characteristic `2A19`, when provided by the belt.

Trigger an obstacle while a directional cue is active, disconnect and reconnect, and verify motor shutoff on loss of the link. The dashboard reports capture-to-command-dispatch timing. Measure obstacle-to-motor timing separately on the bench.

## Phone telemetry and recordings

On the phone, open **Testing and data tools** for dashboard sharing and session recording.

- For a local dashboard feed, set `EXPO_PUBLIC_TELEMETRY_URL` to a reachable local hostname such as `http://laptop.local:5173` and set the same `EXPO_PUBLIC_TELEMETRY_TOKEN` for Expo and Vite. Run `npm run dashboard -- --host 0.0.0.0` on a trusted demo LAN. In the dashboard enter the token and click **Connect phone feed**. On the phone choose **Share with dashboard**. To see actual LiDAR points, choose **iPhone LiDAR** and **Share 3D scan with dashboard**, then select **3D scan** in the dashboard. Rebuild the iPhone app to pick up the native preview support. The scan shows the current frame, with color indicating height relative to the phone. The relay keeps only the latest frame in memory and excludes raw depth images, RGB, pose, and destination text.
- For training data, choose **Start recording**, stop the session, then choose **Export session**. Each export contains up to 240 NDJSON records. Real sessions capture downsampled depth, confidence, intrinsics, pose, BEV, and navigation/reflex decisions with aligned timestamps. Exported sessions are kept separate from the live relay.

## Databricks and Core ML

The repository has no trained Core ML artifact. Simulation shows rule-based scores from the mock grid. On an iPhone, LiDAR clearance rules provide the local baseline until a bundled Core ML model is enabled and returns valid scores.

The model takes a 40 × 20 LiDAR occupancy grid and scores nine local headings from −60° to +60°. The app combines those scores with the Google route bearing after inference and rejects directions without enough observed clearance. Google calculates the walking route separately. Immediate obstacle warnings run directly from LiDAR before inference.

The ML teammate can upload consented exports to an authorized Databricks Volume and run `ml/train.py` as a Python script task on a Databricks ML runtime with PySpark, PyTorch, NumPy, and MLflow 3. Pass the input path and `--experiment /Shared/navigation-belt`. At least two independent LiDAR sessions are needed. The job deduplicates frames, generates geometric candidate labels, trains with sessions held out, compares against a short-clearance baseline, and logs a versioned model and `evaluation.json`. Load that report in the dashboard. `--register-candidate catalog.schema.model` optionally registers a candidate in Unity Catalog.

On the Mac, use `ml/export_coreml.py MODEL_URI VERSION` in an environment with MLflow, PyTorch and Core ML Tools. It checks Core ML predictions against PyTorch and writes `Traversability.mlpackage`. Set `VERSION` to the evaluation report's model version, place the artifact under `modules/navigation-depth/ios/Models/`, and rebuild. In **iPhone LiDAR → Testing and data tools**, select **Enable Core ML** to evaluate the model on-device. Review performance in sighted device tests before relying on its guidance.

The training labels are geometric candidates. Evaluate against independently reviewed outcomes before relying on a model in the field. See [AGENTS.md](AGENTS.md) for interface details.
