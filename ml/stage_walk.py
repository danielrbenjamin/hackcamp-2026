"""Stage a Lantern walk ZIP in the Unity Catalog volume before running ingestion."""

import argparse
import json
import re
import shutil
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
                or sum(entry.file_size for entry in entries) > 1_000_000_000):
            raise ValueError("Invalid Lantern walk archive")

        manifest = metadata[0]
        session_id = Path(manifest).stem
        rows = [json.loads(line) for line in bundle.read(manifest).splitlines()]
        if not 1 <= len(rows) <= 120:
            raise ValueError("Invalid frame count")

        expected = {manifest}
        for index, row in enumerate(rows):
            if (row.get("schema_version") != 1 or row.get("source_type") != "iphone_recording"
                    or row.get("session_id") != session_id or row.get("frame_id") != index):
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
            width, height = row["depth_width"], row["depth_height"]
            if not all(type(size) is int and 0 < size <= 512 for size in (width, height)):
                raise ValueError(f"Invalid depth dimensions in frame {index}")
            if paths[1] not in names or bundle.getinfo(paths[1]).file_size != width * height * 4:
                raise ValueError(f"Invalid depth byte count in frame {index}")
            for path, size in ((paths[2], width * height), (paths[3], 96 ** 2), (paths[4], 96 ** 2)):
                if path in expected and (path not in names or bundle.getinfo(path).file_size != size):
                    raise ValueError(f"Invalid raster byte count for {path}")
        if expected != names:
            raise ValueError("Walk archive contains missing or unexpected assets")

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
