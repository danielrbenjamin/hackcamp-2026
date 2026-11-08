# iPhone recordings to the Lantern Lakehouse

1. Rebuild the iPhone development app after these Swift changes. Enable **Preview hazard models**, start recording under **Testing and data tools**, and export the session. The export keeps sampled depth and the latest available model preview, including that preview's original timestamp and pose. It does not require dashboard sharing.
2. Import the updated `lantern_lakehouse.ipynb` into Databricks. It contains the adapter, so a separate Python module upload is unnecessary. Run all cells with access to `workspace.default` and its Volume.
3. Upload the exported `navigation-*.ndjson` to `/Volumes/workspace/default/lantern_walks/incoming/` and rerun the notebook. Existing flat `.jsonl` files also work.
4. Inspect `lantern_silver`, `lantern_gold_hazards`, `lantern_pedestrian_tracks`, `lantern_review_candidates` and `lantern_sessions` in `workspace.default`. Raw lines, including malformed or rejected records, remain in `lantern_bronze`; the notebook prints the rejected-record count.

## What the adapter preserves

- Embedded sampled depth stays in `inline_depth`; no depth file is required. RGB files are not exported by this app. Such frames have `data_quality = embedded_depth_no_rgb` and `rgb_depth_aligned = false`. They are useful for analysis, but are not complete RGB-D training examples.
- `camera_pose_matrix` belongs to the navigation observation; `prediction_camera_pose_matrix` and `prediction_ts_ms` belong to the model preview. A slow model result is never relabelled with the current sensor timestamp.
- Gold can record detected mask regions with `evidence_type = mask_labels`, `confidence = null`, and a separate `mask_fraction`. Coverage is not probability. Existing flat-record probabilities remain supported with their original thresholds. These are diagnostic events, not commands to the belt.
- Core ML artifact version metadata is exported when present. It is not inferred from UI status strings or assumed to be a Unity Catalog version. Missing versions and missing mask probabilities are flagged for review.
- A person is converted to ARKit world coordinates only using the preview's own pose, or an observation pose from the same captured frame. Older exports lacking a matching pose retain phone-relative/image coordinates and get no world-motion estimate. Track windows include the tracking generation and deduplicate repeated previews. The phone forecasts 0.6 seconds; the existing Lakehouse columns explicitly forecast 1 second from the estimated velocity.
- Old iPhone exports without model previews can still populate sensor/session tables. Missing images, predictions or artifact metadata cannot be reconstructed from those exports.

## Local checks

```sh
python -m unittest discover -s databricks -p test_recording_adapter.py -v
```

After editing `recording_adapter.py`, update its embedded notebook cell:

```sh
python databricks/sync_recording_adapter.py
```

The tests check both export formats, timestamps, missing inputs, coordinate transforms and notebook/source agreement. Spark/Delta execution still requires verification in Databricks, and Swift changes require a development build on a LiDAR iPhone. This pipeline does not automatically upload recordings, retrain models or deploy them.
