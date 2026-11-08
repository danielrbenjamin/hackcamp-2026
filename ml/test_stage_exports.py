import json
from pathlib import Path
import struct
import tempfile
import unittest
from uuid import uuid4
from zipfile import ZipFile

from stage_walk import stage_walk, VOLUME
from stage_exports import stage_exports
from build_stage_notebook import staging_source


def archive(path, consent=True, rgb=b'jpeg fixture', extra=None):
    session = str(uuid4())
    paths = dict(rgb_path=f'rgb/{session}/0.jpg', depth_path=f'depth/{session}/0.f32')
    row = dict(schema_version=1, source_type='iphone_recording', session_id=session, frame_id=0,
               consent=dict(granted=consent, scope='ml-walk-recording'), depth_width=1, depth_height=1,
               captured_at_ms=1000, rgb_ts_ms=1000, depth_ts_ms=1000,
               **{key: f'{VOLUME}/{value}' for key, value in paths.items()})
    with ZipFile(path, 'w') as bundle:
        bundle.writestr(paths['rgb_path'], rgb)
        bundle.writestr(paths['depth_path'], struct.pack('<f', 2))
        bundle.writestr(f'incoming/{session}.jsonl', json.dumps(row) + '\n')
        if extra: bundle.writestr(extra, b'bad')
    return row


class StageTests(unittest.TestCase):
    def test_full_export_flow_stages_sensors_then_ingests_ready_jsonl_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'exports').mkdir()
            row = archive(root / 'exports' / 'walk.zip')
            results = stage_exports(root)
            self.assertEqual(results[0]['status'], 'staged')
            manifest = Path(results[0]['manifest'])
            self.assertEqual(json.loads(manifest.read_text())['session_id'], row['session_id'])
            self.assertTrue((root / 'rgb' / row['session_id'] / '0.jpg').exists())
            self.assertEqual(stage_exports(root)[0]['status'], 'already_staged')

    def test_invalid_archives_are_preserved_and_do_not_block_valid_walks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'exports').mkdir()
            (root / 'exports' / 'bad.zip').write_bytes(b'not a ZIP')
            archive(root / 'exports' / 'valid.zip')
            self.assertEqual([r['status'] for r in stage_exports(root)], ['rejected', 'staged'])
            self.assertTrue((root / 'exports' / 'bad.zip').exists())
            self.assertEqual([r['status'] for r in stage_exports(root)], ['already_rejected', 'already_staged'])

    def test_missing_consent_and_traversal_never_publish_metadata(self):
        for arguments in [dict(consent=False), dict(extra='../../outside.txt')]:
            with self.subTest(arguments=arguments), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / 'input.zip'
                archive(path, **arguments)
                with self.assertRaises(ValueError): stage_walk(path, root / 'volume')
                self.assertFalse((root / 'volume' / 'incoming').exists())

    def test_retry_cannot_replace_assets_of_an_existing_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'input.zip'
            row = archive(path)
            manifest = stage_walk(path, root / 'volume')
            self.assertEqual(stage_walk(path, root / 'volume'), manifest)
            (root / 'volume' / 'rgb' / row['session_id'] / '0.jpg').write_bytes(b'changed')
            with self.assertRaises(ValueError): stage_walk(path, root / 'volume')

    def test_hash_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'exports').mkdir()
            archive(root / 'exports' / ('a' * 64 + '.zip'))
            self.assertEqual(stage_exports(root)[0]['status'], 'rejected')

    def test_standalone_notebook_contains_and_executes_the_tested_stager(self):
        path = Path(__file__).resolve().parents[1] / 'databricks' / 'stage_walk_exports.ipynb'
        book = json.loads(path.read_text())
        source = ''.join(book['cells'][0]['source'])
        self.assertEqual(source, staging_source())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'exports').mkdir()
            archive(root / 'exports' / 'walk.zip')
            namespace = dict(test_volume=root)
            exec(source.replace('print(json.dumps(stage_exports(), indent=2))', 'result = stage_exports(test_volume)'), namespace)
            self.assertEqual(namespace['result'][0]['status'], 'staged')


if __name__ == '__main__':
    unittest.main()
