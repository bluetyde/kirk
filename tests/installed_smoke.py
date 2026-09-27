"""Smoke test for an installed kirk-kinetics wheel (run by CI's packaging job, not by unittest discovery).

    python -I tests/installed_smoke.py REPO_ROOT

-I keeps the repository off sys.path, so this checks the installed package. Data (library folders, golden
vectors) come from the repository; code comes from the install.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def main(repo: Path) -> None:
    import kirk
    from kirk import ENGINE_VERSION, Engine, params_digest
    from kirk.contracts.validate import json_form, validate_command, validate_snapshot
    from kirk.libformat import load_params

    installed = Path(kirk.__file__).resolve()
    assert repo.resolve() not in installed.parents, f"imported the repository copy: {installed}"

    params = load_params(repo / "schema" / "vectors" / "synthetic-core")   # needs the packaged library schema
    pins = json.loads((repo / "schema" / "engine-vectors" / "source-level.json").read_text(encoding="utf-8"))["pins"]
    assert pins["engineVersion"] == ENGINE_VERSION, (pins["engineVersion"], ENGINE_VERSION)
    assert params_digest(params) == pins["paramsDigest"], "params digest differs from the golden vectors"

    e = Engine(params, {})
    cmd = {"type": "rod.move", "rod": "regulating", "direction": "out"}
    assert validate_command(cmd) == [], validate_command(cmd)                # needs the packaged command schema
    e.submit(cmd)
    e.advance(1.0)
    issues = validate_snapshot(json_form(e.snapshot(include_shape=True)))     # needs the packaged snapshot schema
    assert issues == [], issues

    script = Path(sys.executable).with_name("kirk-validate")
    out = subprocess.run([str(script), str(repo / "libraries" / "triga-jsi")], capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout.startswith("OK"), (out.returncode, out.stdout, out.stderr)
    print(f"installed kirk {ENGINE_VERSION} from {installed.parent}: OK")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
