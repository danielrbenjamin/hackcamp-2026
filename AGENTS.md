# Lantern

Keep the demo usable without a phone, model artifact, belt or internet. Work from the repository root with Node and npm. Run `npm run typecheck`, `npm test` and `npm run build:dashboard` after shared changes. Verify Swift changes with a development build on a LiDAR-equipped iPhone.

## Module ownership

- App and dashboard teammate owns `mobile/`, `dashboard/`, `modules/navigation-depth/`, `plugins/` and shared guidance. Expo generates root `ios/` on the Mac. Keep durable native source in the local module and the Google AppDelegate setup in the config plugin.
- `ml/` contains recording staging and the legacy BEV training and export scripts. `databricks/` contains hazard model training and Lakehouse ingestion.
- `firmware/` contains the ESP32 sketch. Confirm the board, wiring and packet format before flashing.

## Interfaces and constraints

- `shared/contracts.ts` defines telemetry and provider interfaces. The local iOS module provides ARKit observations, CoreBluetooth command output and Core ML inference. Camera frames stay on-device. Raw depth and pose are included in explicit session exports.
- Glass, stair, and person inference runs serially off the ARKit delegate queue. Fresh model hazards are rebased to the current phone frame for local direction and obstacle cues. Glass uses bearing only. The independent raw LiDAR reflex has priority. Opt-in 3D scan sharing relays the separate frame-timestamped diagnostic preview. Validate inference and warnings on iPhone captures.
- Provisional BEV uses 40 columns × 20 rows, 0.25 m cells and row-major order. Left is negative, right is positive and the bottom row is closest to the phone. Values 0, 1 and 2 mean unknown, observed free and occupied. It spans ±5 m laterally and 5 m forward, with samples capped at a 5 m radius. ARKit pose is column-major camera-to-world in metres. The native grid uses a fixed mounting-height assumption and projects recent occupied cells into unknown space for up to 250 ms. Free cells and reflex zones come from the current frame.
- The legacy BEV model accepts float32 `bev` shaped `[1, 1, 20, 40]` and returns nine `scores`. The live selector uses LiDAR clearance and hazard geometry. The Google route bearing uses the snapped location and active route geometry. The app subtracts the ARKit rear-camera heading to obtain a clockwise-positive relative angle.
- The reflex runs in JS independently of inference. The immediate raw LiDAR warning uses the center zone (about ±15°) below 0.85 m. A credible center return wins even when side coverage is missing. Missing or stale coverage suppresses direction. Direction cues default on and require a fresh route and an observed-free corridor. The belt connection is only required for physical output. Verify calibration and measure obstacle-to-buzzer response separately from dispatch latency.
- The seven-byte belt packet retains far-left, left, centre, right and far-right strength slots. The ESP32 drives three physical buzzers on GPIO 25 (left), 33 (front) and 26 (right), folding far-side cues into their corresponding side. It clears commands on disconnect or timeout. Obstacle cues take priority. The app reads battery if the hardware exposes the standard battery characteristic.
- Telemetry v1 uses epoch milliseconds and optional sensor-monotonic milliseconds. NDJSON includes consent, session ID, sequence and synchronized frame data. Recorded depth is sampled every eighth pixel in both axes, row-major. Intrinsics are `[fx, fy, cx, cy]` in sampled-image coordinates. Invalid recorded depths are null and ARKit confidence values are 0, 1 and 2. The live relay receives a redacted summary and operates outside the guidance loop. Opt-in scan sharing sends the full ARKit depth raster with sampled color and confidence. The dashboard reconstructs finite positive returns using camera intrinsics and a rotation basis.
- The live scan can also include a scan-session-relative translation and yaw while ARKit tracking is normal. The dashboard uses this to reproject up to 1.5 seconds of earlier measured returns into gaps in the live view. Model previews, exported sessions and guidance do not use the fused view.

## Integration order

Build and install on the Mac first. Verify depth, uncertainty and warning transitions while stationary, then test BLE on the bench and walking guidance with a sighted spotter. The Swift module, ESP32 firmware and Databricks training still need device or service verification.
