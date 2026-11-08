# Smart Navigation Belt

Keep the demo usable without a phone, model artifact, belt or internet. Work from the repository root with Node and npm. Run `npm run typecheck`, `npm test` and `npm run build:dashboard` after shared changes. Verify Swift changes with a development build on a LiDAR-equipped iPhone.

## Module ownership

- App and dashboard teammate owns `mobile/`, `dashboard/`, `modules/navigation-depth/`, `plugins/` and shared guidance. Expo generates root `ios/` on the Mac. Keep durable native source in the local module and the Google AppDelegate setup in the config plugin.
- `ml/` contains the Databricks training and Core ML export scripts.
- `firmware/` contains the ESP32 sketch. Confirm the board, wiring and packet format before flashing.

## Interfaces and constraints

- `shared/contracts.ts` defines telemetry and provider interfaces. The local iOS module provides ARKit observations, CoreBluetooth command output and Core ML inference. Camera frames stay on-device. Raw depth and pose are included in explicit session exports.
- Provisional BEV uses 40 columns × 20 rows, 0.25 m cells and row-major order. Left is negative, right is positive and the bottom row is closest to the phone. Values 0, 1 and 2 mean unknown, observed free and occupied. It spans ±5 m laterally and 5 m forward, with samples capped at a 5 m radius. ARKit pose is column-major camera-to-world in metres. The native grid uses a fixed mounting-height assumption and projects recent occupied cells into unknown space for up to 250 ms. Free cells and reflex zones come from the current frame.
- Model input `bev` is float32 `[1, 1, 20, 40]`, cell values divided by 2. Output `scores` is nine values in `HEADINGS` order from −60° to +60°, with values from 0 to 1. Model metadata must include a version. Missing or malformed predictions fall back to the clearance baseline. The Google route bearing uses the snapped location and active route geometry. The app subtracts the ARKit rear-camera heading to obtain a clockwise-positive relative angle after inference. Validate a model before explicitly selecting it on-device.
- The reflex reads forward depth zones independently of model inference. A credible nearby return wins even if other zones are unknown. Missing or stale coverage suppresses direction. The native diagnostics run the reflex in JS when a frame arrives, with a timer to catch stale frames. Measure the full hardware response separately from dispatch latency. Direction cues default on and require a fresh route and an observed-free corridor. The belt connection is only required for physical output. Verify calibration before walking tests.
- Motor order is far left, left, centre, right, far right. The firmware uses a versioned seven-byte packet and clears commands on disconnect or timeout. Obstacle cues take priority over route cues. The app reads battery if the hardware exposes the standard battery characteristic.
- Telemetry v1 uses epoch milliseconds and optional sensor-monotonic milliseconds. NDJSON includes consent, session ID, sequence and synchronized frame data. Depth is sampled every eighth pixel in both axes, row-major. Intrinsics are `[fx, fy, cx, cy]` in sampled-image coordinates. Invalid depths are null and ARKit confidence values are 0, 1 and 2. The live relay receives a redacted summary and operates outside the guidance loop. Opt-in scan sharing adds up to 3,000 phone-relative `[right, up, forward]` points in metres from the current frame.

## Integration order

Build and install on the Mac first. Verify depth, uncertainty and warning transitions while stationary, then test BLE on the bench and walking guidance with a sighted spotter. The Swift module, ESP32 firmware and Databricks training still need device or service verification.
