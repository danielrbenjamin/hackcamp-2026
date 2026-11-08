"""Embed the tested adapter in the notebook before importing it into Databricks."""
import json
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    path = root / 'lantern_lakehouse.ipynb'
    notebook = json.loads(path.read_text(encoding='utf-8'))
    source = (root / 'recording_adapter.py').read_text(encoding='utf-8')
    matches = [cell for cell in notebook['cells']
               if cell.get('metadata', {}).get('lantern_recording_adapter')
               or '"""Normalize Lantern exports without Spark' in ''.join(cell.get('source', []))]
    if len(matches) != 1:
        raise ValueError('Expected exactly one adapter cell')
    cell = matches[0]
    cell['metadata']['lantern_recording_adapter'] = True
    cell['source'] = ('%python\n' + source).splitlines(keepends=True)
    cell['outputs'] = []
    cell['execution_count'] = None
    path.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
