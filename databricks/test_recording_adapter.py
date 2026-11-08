import ast
import base64
import copy
import json
from pathlib import Path
import unittest

from recording_adapter import normalize_json, normalize_record, world_point, pose_matrix

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def recording():
    return dict(schemaVersion=1, sessionId='walk-1', sequence=2,
                consent=dict(granted=True, scope='local-recording'), frame=dict(
                    observation=dict(source='arkit', timeMs=2000, pose=IDENTITY,
                                     depth=dict(width=2, height=2, intrinsics=[2, 2, 1, 1],
                                                meters=[1, None, 2, 0], confidence=[2, 0, 1, 0]))))


def preview():
    labels = bytes([1] + [0] * (96 * 96 - 1))
    return dict(timeMs=1000, cameraPose=IDENTITY, trackingSession='4',
                models=dict(glass='Preview', stairs='Preview', person='Preview'),
                masks=[dict(kind='glass', size=96, labels=base64.b64encode(labels).decode())],
                people=[dict(trackId=7, confidence=0.9, box=[0.1, 0.1, 0.2, 0.5],
                             position=[1, 0, 2], predictedPosition=[1.6, 0, 2], predictionHorizonMs=600)])


class AdapterTests(unittest.TestCase):
    def test_actual_export_identity_and_embedded_depth(self):
        result = normalize_record(recording())
        self.assertEqual((result['session_id'], result['frame_id'], result['captured_at_ms']), ('walk-1', 2, 2000))
        self.assertEqual(result['depth_valid_fraction'], 0.5)
        self.assertEqual(result['inline_depth']['meters'], [1, None, 2, None])
        self.assertIsNone(result['rgb_path'])
        self.assertIsNone(result['depth_path'])
        self.assertIn('model_preview_not_recorded', result['adapter_warnings'])

    def test_legacy_flat_records_keep_probabilities_paths_and_versions(self):
        original = dict(source_type='iphone_recording', session_id='old', frame_id=1,
                        captured_at_ms=1000, rgb_path='/Volumes/rgb.png', glass_probability=0.81,
                        glass_model_version='3', people=[dict(track_id='a', coordinate_frame='arkit_world')])
        result = normalize_record(original)
        self.assertEqual(result['glass_probability'], 0.81)
        self.assertEqual(result['glass_model_version'], '3')
        self.assertEqual(result['people'][0]['coordinate_space_id'], 'legacy')
        self.assertNotIn('coordinate_space_id', original['people'][0])

    def test_mask_coverage_is_not_a_probability_and_status_is_not_a_version(self):
        value = recording()
        value['frame']['modelPreview'] = preview()
        result = normalize_record(value)
        self.assertEqual(result['glass_mask_fraction'], 1 / (96 * 96))
        self.assertIsNone(result['glass_probability'])
        self.assertIsNone(result['glass_model_version'])
        self.assertEqual(result['prediction_ts_ms'], 1000)
        self.assertEqual(result['prediction_sensor_gap_ms'], 1000)

    def test_stale_preview_uses_its_own_pose_and_velocity_units(self):
        value = recording()
        value['frame']['observation']['pose'] = IDENTITY[:12] + [99, 0, 99, 1]
        value['frame']['modelPreview'] = preview()
        person = normalize_record(value)['people'][0]
        self.assertEqual(person['coordinate_frame'], 'arkit_world')
        self.assertEqual((person['x_m'], person['z_m']), (1, -2))
        self.assertAlmostEqual(person['vx_mps'], 1)
        self.assertAlmostEqual(person['vz_mps'], 0)
        self.assertEqual(person['coordinate_space_id'], '4')

    def test_old_stale_preview_never_uses_current_camera_pose(self):
        value = recording()
        value['frame']['modelPreview'] = preview()
        del value['frame']['modelPreview']['cameraPose']
        result = normalize_record(value)
        person = result['people'][0]
        self.assertEqual(person['coordinate_frame'], 'phone_relative')
        self.assertIsNone(person['vx_mps'])
        self.assertIn('prediction_pose_unavailable', result['adapter_warnings'])

    def test_old_same_frame_preview_can_use_matching_observation_pose(self):
        value = recording()
        value['frame']['modelPreview'] = preview()
        value['frame']['modelPreview']['timeMs'] = 2000
        del value['frame']['modelPreview']['cameraPose']
        self.assertEqual(normalize_record(value)['people'][0]['coordinate_frame'], 'arkit_world')

    def test_rotated_camera_and_translation_transform_phone_relative_points(self):
        pose = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 10, 1, 20, 1]
        self.assertEqual(world_point([1, 2, 3], pose_matrix(pose)), [13, 3, 21])
        bad = copy.deepcopy(IDENTITY)
        bad[0] = 2
        self.assertIsNone(pose_matrix(bad))

    def test_2d_only_detection_does_not_gain_coordinates(self):
        value = recording()
        value['frame']['modelPreview'] = preview()
        person = value['frame']['modelPreview']['people'][0]
        person.pop('position')
        result = normalize_record(value)['people'][0]
        self.assertEqual(result['coordinate_frame'], 'image')
        self.assertIsNone(result['x_m'])
        self.assertIsNone(result['vx_mps'])

    def test_corrupt_mask_is_flagged_without_losing_depth(self):
        value = recording()
        value['frame']['modelPreview'] = preview()
        value['frame']['modelPreview']['masks'][0]['labels'] = 'bad!'
        result = normalize_record(value)
        self.assertEqual(result['masks'], [])
        self.assertIn('invalid_mask', result['adapter_warnings'])
        self.assertIsNotNone(result['inline_depth'])

    def test_invalid_nonconsented_and_simulated_records_are_rejected(self):
        self.assertIsNone(normalize_json('{broken'))
        self.assertIsNone(normalize_json('[]'))
        for field, replacement in [('consent', dict(granted=False)), ('sessionId', None), ('sequence', True)]:
            value = recording()
            value[field] = replacement
            self.assertIsNone(normalize_json(json.dumps(value)))
        value = recording()
        value['frame']['observation']['source'] = 'simulated'
        self.assertIsNone(normalize_json(json.dumps(value)))

    def test_nonfinite_depth_is_null_and_no_invented_model_versions(self):
        value = recording()
        value['frame']['observation']['depth']['meters'][0] = float('nan')
        value['frame']['modelPreview'] = preview()
        value['frame']['modelPreview']['modelVersions'] = dict(glass='artifact-3')
        result = json.loads(normalize_json(json.dumps(value)))
        self.assertIsNone(result['inline_depth']['meters'][0])
        self.assertEqual(result['glass_model_version'], 'artifact-3')
        self.assertIsNone(result['stair_model_version'])

    def test_repeated_preview_retains_original_measurement_time(self):
        value = recording()
        value['frame']['modelPreview'] = preview()
        first = normalize_record(value)
        value['sequence'] = 3
        value['frame']['observation']['timeMs'] = 2500
        second = normalize_record(value)
        self.assertNotEqual(first['captured_at_ms'], second['captured_at_ms'])
        self.assertEqual(first['prediction_ts_ms'], second['prediction_ts_ms'])
        self.assertEqual(first['people'], second['people'])

    def test_deployed_notebook_embeds_the_exact_tested_adapter_and_python_parses(self):
        root = Path(__file__).resolve().parent
        book = json.loads((root / 'lantern_lakehouse.ipynb').read_text(encoding='utf-8'))
        adapter = (root / 'recording_adapter.py').read_text(encoding='utf-8')
        cells = [cell for cell in book['cells'] if cell['metadata'].get('lantern_recording_adapter')]
        self.assertEqual(len(cells), 1)
        self.assertEqual(''.join(cells[0]['source']), '%python\n' + adapter)
        for cell in book['cells'][1:]:
            ast.parse(''.join(cell['source']).replace('%python', '', 1))


if __name__ == '__main__':
    unittest.main()
