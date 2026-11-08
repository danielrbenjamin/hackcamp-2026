"""Stage a Lantern walk ZIP in the Unity Catalog volume before running ingestion."""

import argparse
import json
import re
import shutil
import hashlib
from uuid import UUID
from pathlib import Path
from zipfile import ZipFile

VOLUME = Path("/Volumes/workspace/default/lantern_walks")
SESSION = r"[A-Fa-f0-9-]{36}"
ASSET_FIELDS = (
    "rgb_path", "depth_path", "depth_confidence_path",
    "glass_mask_path", "stair_mask_path",
)


def stage_walk(archive, volume=VOLUME):
    with ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = {entry.filename for entry in entries}
        metadata = [name for name in names if re.fullmatch(rf"incoming/{SESSION}\.jsonl", name)]
        if (len(metadata) != 1 or len(names) != len(entries) or len(entries) > 601
                or any(entry.flag_bits & 1 for entry in entries)
                or sum(entry.file_size for entry in entries) > 1_000_000_000):
            raise ValueError("Invalid Lantern walk archive")

        manifest = metadata[0]
        session_id = Path(manifest).stem
        UUID(session_id)
        if bundle.getinfo(manifest).file_size > 20_000_000:
            raise ValueError("Walk metadata is too large")
        manifest_bytes = bundle.read(manifest)
        rows = [json.loads(line) for line in manifest_bytes.splitlines()]
        if not 1 <= len(rows) <= 120:
            raise ValueError("Invalid frame count")

        expected = {manifest}
        for index, row in enumerate(rows):
            if (not isinstance(row, dict) or not isinstance(row.get("consent"), dict)
                    or row.get("schema_version") != 1 or row.get("source_type") != "iphone_recording"
                    or row.get("session_id") != session_id or row.get("frame_id") != index
                    or row.get("consent", {}).get("granted") is not True):
                raise ValueError(f"Invalid frame metadata at row {index + 1}")
            key = f"{session_id}/{index}"
            paths = (f"rgb/{key}.jpg", f"depth/{key}.f32", f"depth/{key}.confidence.u8",
                     f"masks/{key}.glass.u8", f"masks/{key}.stair.u8")
            for field, path in zip(ASSET_FIELDS, paths):
                if field not in row and field not in ("rgb_path", "depth_path"):
                    continue
                if row.get(field) != f"{VOLUME}/{path}":
                    raise ValueError(f"Unexpected {field} in frame {index}")
                expected.add(path)
            if paths[0] not in names or not 0 < bundle.getinfo(paths[0]).file_size <= 24_000_000:
                raise ValueError(f"Invalid camera image size in frame {index}")
            width, height = row["depth_width"], row["depth_height"]
            if not all(type(size) is int and 0 < size <= 512 for size in (width, height)):
                raise ValueError(f"Invalid depth dimensions in frame {index}")
            if paths[1] not in names or bundle.getinfo(paths[1]).file_size != width * height * 4:
                raise ValueError(f"Invalid depth byte count in frame {index}")
            rasters = [(paths[2], width * height)]
            for path, field, native_size in ((paths[3], "glass_mask_size", 224), (paths[4], "stair_mask_size", 384)):
                if path in expected:
                    size = row.get(field, 96)
                    if type(size) is not int or size not in (96, native_size):
                        raise ValueError(f"Invalid mask size for {path}")
                    rasters.append((path, size ** 2))
            for path, size in rasters:
                if path in expected and (path not in names or bundle.getinfo(path).file_size != size):
                    raise ValueError(f"Invalid raster byte count for {path}")
        if expected != names:
            raise ValueError("Walk archive contains missing or unexpected assets")

        # Retries must not overwrite a previously published session with different
        # images under the same paths. Verify content before treating it as staged.
        published = volume / manifest
        if published.exists():
            for name in expected:
                destination = volume / name
                if (not destination.is_file() or hashlib.sha256(destination.read_bytes()).digest()
                        != hashlib.sha256(bundle.read(name)).digest()):
                    raise ValueError("A different or incomplete session already exists")
            return published

        # Publish metadata last so ingestion never starts on an incomplete upload.
        for name in sorted(expected - {manifest}) + [manifest]:
            destination = volume / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(name) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)
    return volume / manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    print(stage_walk(parser.parse_args().archive))
