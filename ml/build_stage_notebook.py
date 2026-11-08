"""Generate a standalone staging notebook; no Python import-path setup needed."""
import json
from pathlib import Path


def staging_source():
    root = Path(__file__).resolve().parent
    walk = (root / 'stage_walk.py').read_text(encoding='utf-8').split('if __name__ == "__main__":')[0]
    batch = (root / 'stage_exports.py').read_text(encoding='utf-8').split("if __name__ == '__main__':")[0]
    batch = batch.replace('from stage_walk import stage_walk, VOLUME\n', '')
    return walk + '\n' + batch + '\nprint(json.dumps(stage_exports(), indent=2))\n'


if __name__ == '__main__':
    destination = Path(__file__).resolve().parents[1] / 'databricks' / 'stage_walk_exports.ipynb'
    book = dict(nbformat=4, nbformat_minor=5,
                metadata={'language_info': {'name': 'python'}},
                cells=[dict(cell_type='code', execution_count=None, metadata={}, outputs=[],
                            source=staging_source().splitlines(keepends=True))])
    destination.write_text(json.dumps(book, indent=1) + '\n', encoding='utf-8')
