"""Lakeflow task: stage new immutable ZIPs before running the Lakehouse notebook."""
import hashlib
import json
import re
from pathlib import Path
from zipfile import BadZipFile

from stage_walk import stage_walk, VOLUME


def stage_exports(volume=VOLUME):
    volume = Path(volume)
    exports = volume / 'exports'
    exports.mkdir(parents=True, exist_ok=True)
    ledger = volume / 'upload_receipts'
    ledger.mkdir(parents=True, exist_ok=True)
    results = []
    for archive in sorted(exports.glob('*.zip')):
        digest = hashlib.sha256()
        with archive.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        key = digest.hexdigest()
        receipt = ledger / (key + '.json')
        if receipt.exists():
            try:
                previous = json.loads(receipt.read_text())
                if previous.get('sha256') == key and previous.get('status') in ('staged', 'rejected'):
                    results.append(dict(archive=archive.name, status='already_' + previous['status']))
                    continue
            except (ValueError, OSError):
                pass # An interrupted receipt write is safe to retry.
        try:
            if re.fullmatch(r'[a-f0-9]{64}', archive.stem) and archive.stem != key:
                raise ValueError('Archive checksum does not match its filename')
            manifest = stage_walk(archive, volume)
            result = dict(archive=archive.name, status='staged', manifest=str(manifest), sha256=key)
        except (ValueError, KeyError, TypeError, BadZipFile, NotImplementedError) as error:
            # Preserve rejected ZIPs and report them, without blocking other walks.
            # Storage/network errors instead fail the task so Lakeflow can retry.
            result = dict(archive=archive.name, status='rejected', error=str(error), sha256=key)
        receipt.write_text(json.dumps(result, sort_keys=True), encoding='utf-8')
        results.append(result)
    return results


if __name__ == '__main__':
    print(json.dumps(stage_exports(), indent=2))
