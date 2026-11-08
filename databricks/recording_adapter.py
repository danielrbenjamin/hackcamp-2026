"""Normalize Lantern exports without Spark or fabricated sensor/model evidence.

This module is embedded verbatim in lantern_lakehouse.ipynb so Databricks workers
do not need a separate local Python module installed.
"""
import base64
import json
import math

MAX_PIXELS = 512 * 512


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def probability(value):
    value = number(value)
    return value if value is not None and 0 <= value <= 1 else None


def pose_matrix(value):
    if not isinstance(value, list) or len(value) != 16 or any(number(n) is None for n in value):
        return None
    # A rigid ARKit transform, stored column-major. Reject malformed scale/basis.
    axes = [value[start:start + 3] for start in (0, 4, 8)]
    if any(abs(sum(n * n for n in axis) - 1) > 0.02 for axis in axes):
        return None
    if any(abs(sum(axes[a][i] * axes[b][i] for i in range(3))) > 0.02 for a, b in ((0, 1), (0, 2), (1, 2))):
        return None
    if any(abs(value[i]) > 1e-5 for i in (3, 7, 11)) or abs(value[15] - 1) > 1e-5:
        return None
    return value


def world_point(point, pose):
    if not pose or not isinstance(point, list) or len(point) != 3 or any(number(n) is None for n in point):
        return None
    hx, hz = -pose[8], -pose[10]
    length = math.hypot(hx, hz)
    if length <= 0.4:
        return None
    hx, hz = hx / length, hz / length
    right, up, forward = point
    return [pose[12] - hz * right + hx * forward, pose[13] + up,
            pose[14] + hx * right + hz * forward]


def normalize_record(record):
    if not isinstance(record, dict):
        raise ValueError('record must be an object')
    if record.get('consent', {}).get('granted') is False:
        raise ValueError('recording consent was not granted')
    # Existing flat JSONL recordings remain supported without relabelling data.
    if record.get('source_type') == 'iphone_recording':
        result = dict(record)
        people = result.get('people') or []
        result['people'] = [dict(person, coordinate_space_id=person.get('coordinate_space_id', 'legacy'))
                            for person in people if isinstance(person, dict)]
        return result
    if record.get('schemaVersion') != 1 or record.get('consent', {}).get('granted') is not True:
        raise ValueError('expected a consented telemetry v1 export')
    frame = record.get('frame') or {}
    observation = frame.get('observation') or {}
    timestamp = number(observation.get('timeMs'))
    sequence = record.get('sequence')
    session = record.get('sessionId')
    if observation.get('source') != 'arkit' or not isinstance(session, str) or not session:
        raise ValueError('not a real iPhone recording')
    if timestamp is None or number(sequence) is None or sequence < 0 or int(sequence) != sequence:
        raise ValueError('missing or invalid frame identity/timestamp')
    result = dict(source_type='iphone_recording', session_id=session, frame_id=int(sequence),
                  captured_at_ms=int(timestamp), camera_pose_matrix=pose_matrix(observation.get('pose')),
                  rgb_path=None, depth_path=None, rgb_ts_ms=None, depth_ts_ms=None,
                  glass_probability=None, stair_riser_probability=None, stair_tread_probability=None,
                  people=[], masks=[], adapter_warnings=[])
    warnings = result['adapter_warnings']
    depth = observation.get('depth')
    if isinstance(depth, dict):
        width, height = depth.get('width'), depth.get('height')
        if (type(width) is int and type(height) is int and width > 0 and height > 0
                and width * height <= MAX_PIXELS and isinstance(depth.get('meters'), list)
                and len(depth['meters']) == width * height):
            meters = [n if number(n) is not None and n > 0 else None for n in depth['meters']]
            confidence = depth.get('confidence')
            if not isinstance(confidence, list) or len(confidence) != len(meters):
                confidence = [None] * len(meters)
            intrinsics = depth.get('intrinsics')
            if (not isinstance(intrinsics, list) or len(intrinsics) != 4
                    or any(number(n) is None for n in intrinsics) or min(intrinsics[:2]) <= 0):
                intrinsics = None
                warnings.append('invalid_depth_intrinsics')
            result['inline_depth'] = dict(width=width, height=height, meters=meters,
                                          confidence=[n if type(n) is int and n in (0, 1, 2) else None for n in confidence],
                                          intrinsics=intrinsics)
            result['depth_ts_ms'] = int(timestamp)
            result['depth_valid_fraction'] = sum(n is not None for n in meters) / len(meters)
        else:
            warnings.append('invalid_embedded_depth')
    warnings.append('rgb_not_exported')
    preview = frame.get('modelPreview')
    if not isinstance(preview, dict) or number(preview.get('timeMs')) is None:
        warnings.append('model_preview_not_recorded')
        return result
    prediction_time = preview['timeMs']
    result['prediction_ts_ms'] = int(prediction_time)
    result['prediction_sensor_gap_ms'] = abs(prediction_time - timestamp)
    versions = preview.get('modelVersions') or {}
    for kind, key in [('glass', 'glass'), ('stairs', 'stair'), ('person', 'people')]:
        version = versions.get(kind)
        result[key + '_model_version'] = version if isinstance(version, str) and version else None
    if any(result[key + '_model_version'] is None for key in ('glass', 'stair', 'people')):
        warnings.append('model_versions_unavailable')
    # A preview has its own camera pose. Older exports can use the observation
    # pose only if they refer to the SAME captured frame, not just a recent one.
    preview_pose = pose_matrix(preview.get('cameraPose'))
    if preview_pose is None and abs(prediction_time - timestamp) <= 1:
        preview_pose = result['camera_pose_matrix']
    if preview_pose is None:
        warnings.append('prediction_pose_unavailable')
    result['prediction_camera_pose_matrix'] = preview_pose
    for mask in preview.get('masks') or []:
        if not isinstance(mask, dict) or mask.get('kind') not in ('glass', 'stairs'):
            continue
        size, labels = mask.get('size'), mask.get('labels')
        if not isinstance(size, int) or size not in (96, 224, 384) or not isinstance(labels, str):
            warnings.append('invalid_mask')
            continue
        try:
            if len(labels) > 4 * math.ceil(MAX_PIXELS / 3):
                raise ValueError('mask too large')
            decoded = base64.b64decode(labels, validate=True)
            allowed = (0, 1) if mask['kind'] == 'glass' else (0, 1, 2)
            if len(decoded) != size * size or any(label not in allowed for label in decoded):
                raise ValueError('invalid mask raster')
        except (ValueError, TypeError):
            warnings.append('invalid_mask')
            continue
        result['masks'].append(dict(kind=mask['kind'], size=size, labels=labels))
        if mask['kind'] == 'glass':
            result['glass_mask_fraction'] = decoded.count(1) / len(decoded)
        else:
            result['stair_riser_mask_fraction'] = decoded.count(1) / len(decoded)
            result['stair_tread_mask_fraction'] = decoded.count(2) / len(decoded)
    if result['masks']:
        warnings.append('mask_probabilities_unavailable')
    for person in (preview.get('people') or [])[:16]:
        if not isinstance(person, dict):
            continue
        box = person.get('box')
        if not isinstance(box, list) or len(box) != 4 or any(probability(n) is None for n in box):
            continue
        world = world_point(person.get('position'), preview_pose)
        local = person.get('position')
        located = world or (local if isinstance(local, list) and len(local) == 3
                           and all(number(n) is not None for n in local) else None)
        track_id = person.get('trackId')
        item = dict(track_id=str(track_id) if isinstance(track_id, int) and not isinstance(track_id, bool) and track_id > 0 else None,
                    confidence=probability(person.get('confidence')), bbox_xywh=box,
                    coordinate_frame='arkit_world' if world else 'phone_relative' if located else 'image',
                    coordinate_space_id=str(preview['trackingSession']) if preview.get('trackingSession') is not None else None,
                    x_m=located[0] if located else None, z_m=located[2] if located else None,
                    vx_mps=None, vz_mps=None)
        horizon = number(person.get('predictionHorizonMs'))
        future = world_point(person.get('predictedPosition'), preview_pose)
        if world and future and horizon is not None and 0 < horizon <= 1000:
            item['vx_mps'] = (future[0] - world[0]) * 1000 / horizon
            item['vz_mps'] = (future[2] - world[2]) * 1000 / horizon
        result['people'].append(item)
    return result


def normalize_json(raw):
    """Spark UDF boundary. Bronze retains rejected source lines for inspection."""
    try:
        return json.dumps(normalize_record(json.loads(raw)), allow_nan=False, separators=(',', ':'))
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return None
