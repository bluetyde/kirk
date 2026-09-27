from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

from kirk.libformat.minischema import Validator
from kirk.libformat.validate import Issue

REPO_ROOT = Path(__file__).resolve().parents[2]
COMMAND_SCHEMA_PATH = REPO_ROOT / "schema" / "command.schema.json"
SNAPSHOT_SCHEMA_PATH = REPO_ROOT / "schema" / "snapshot.schema.json"


def _load_validator(path: Path) -> Validator:
    schema = json.loads(path.read_text(encoding="utf-8"))
    return Validator(schema)


COMMAND_VALIDATOR = _load_validator(COMMAND_SCHEMA_PATH)
SNAPSHOT_VALIDATOR = _load_validator(SNAPSHOT_SCHEMA_PATH)


def json_form(obj: Any) -> Any:
    """Return a deep copy where every non-finite float (NaN, ±inf) becomes None."""
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        return None if not math.isfinite(obj) else obj
    if isinstance(obj, (int, str)) or obj is None:
        return obj
    if isinstance(obj, dict):
        return {k: json_form(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [json_form(v) for v in obj]
    if isinstance(obj, tuple):
        return tuple(json_form(v) for v in obj)
    return copy.deepcopy(obj)


def _find_nonfinite(obj: Any, path: str = "$") -> list[Issue]:
    issues: list[Issue] = []
    if isinstance(obj, bool):
        return issues
    if isinstance(obj, float) and not math.isfinite(obj):
        issues.append(Issue("E_NONFINITE", path, f"non-finite float {obj}"))
        return issues
    if isinstance(obj, dict):
        for k, v in obj.items():
            issues.extend(_find_nonfinite(v, f"{path}.{k}"))
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            issues.extend(_find_nonfinite(v, f"{path}[{i}]"))
    return issues


def validate_command(obj: Any) -> list[Issue]:
    nonfinite = _find_nonfinite(obj)
    if nonfinite:
        return nonfinite
    return [Issue("E_SCHEMA", path, msg) for path, msg in COMMAND_VALIDATOR.errors(obj)]


def validate_snapshot(obj: Any) -> list[Issue]:
    nonfinite = _find_nonfinite(obj)
    if nonfinite:
        return nonfinite
    return [Issue("E_SCHEMA", path, msg) for path, msg in SNAPSHOT_VALIDATOR.errors(obj)]
