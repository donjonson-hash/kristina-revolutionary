"""JSON-lines-free batch oracle for the independent browser-engine parity test."""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from avatar_platform.reconciliation import _source, run_reconciliation
from avatar_platform.reconciliation_setup import prepare_reconciliation

results = []
for case in json.load(sys.stdin):
    try:
        payload = case['payload']
        sources = {side: (base64.b64decode(payload[side]['data'], validate=True), payload[side]['name'])
                   for side in ('left', 'right')}
        operation = case['operation']
        delimiter = payload.get('delimiter', 'auto' if operation == 'prepare' else ',')
        if operation == 'prepare':
            result = prepare_reconciliation(sources, delimiter)
        elif operation == 'inspect':
            result = {}
            for side, (raw, name) in sources.items():
                metadata, rows = _source(raw, name, delimiter)
                result[side] = {**metadata, 'preview': rows[:5]}
        else:
            result = run_reconciliation(sources['left'][0], sources['right'][0],
                                        left_name=sources['left'][1], right_name=sources['right'][1],
                                        key=payload.get('key'), fields=payload.get('fields'),
                                        strip=payload.get('strip', False), delimiter=delimiter)
        results.append({'result': result})
    except (ValueError, TypeError) as exc:
        results.append({'error': str(exc)})
json.dump(results, sys.stdout, ensure_ascii=False)
