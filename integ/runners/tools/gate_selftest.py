# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

import harness  # noqa: E402

ROOT = harness.integ_root()
MAIN = ROOT / "runners" / "python" / "main.py"
TSX = ROOT / "node_modules" / ".bin" / "tsx"
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"ok   {name}")
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"FAIL {name}: {detail}")


def raises(fn, needle: str) -> tuple[bool, str]:
    """Whether fn() raises an error whose text contains needle.

    Args:
        fn (Callable): zero-argument callable expected to raise.
        needle (str): substring the error message must contain.

    Returns:
        tuple: (passed, detail) for check().
    """
    try:
        fn()
    except (KeyError, ValueError) as exc:
        text = str(exc)
        return needle in text, f"raised {text!r}, wanted {needle!r}"
    return False, "did not raise"


def with_manifest(mutate) -> dict:
    """A copy of targets.json with mutate applied, written to a temp root.

    Args:
        mutate (Callable): receives the parsed manifest and edits it.

    Returns:
        dict: the mutated manifest.
    """
    data = json.loads((ROOT / "targets.json").read_text())
    mutate(data)
    return data


def selftest_services_table() -> None:

    def drop_entry() -> None:
        data = with_manifest(lambda d: d["services"].pop("trello"))
        harness.validate_services(data)

    check("services: a service with no entry is rejected",
          *raises(drop_entry, "missing an entry"))

    def orphan_entry() -> None:
        data = with_manifest(lambda d: d["services"].update(
            {"nosuchsvc": {
                "python": [],
                "typescript": []
            }}))
        harness.validate_services(data)

    check("services: an entry naming no target is rejected",
          *raises(orphan_entry, "names no target"))

    def half_declared() -> None:
        data = with_manifest(
            lambda d: d["services"].update({"trello": {
                "python": []
            }}))
        harness.validate_services(data)

    check("services: an entry missing a host is rejected",
          *raises(half_declared, "must declare"))


def selftest_case_validation() -> None:
    cases = [
        {
            "id": "dup",
            "targets": ["ram"],
            "_source": "a.json"
        },
        {
            "id": "dup",
            "targets": ["ram"],
            "_source": "b.json"
        },
    ]
    check("cases: a duplicate id is rejected",
          *raises(lambda: harness.validate_cases(ROOT, cases), "duplicate"))

    unknown = [{
        "id": "solo",
        "targets": ["nosuchtarget"],
        "_source": "a.json"
    }]
    check("cases: an unknown target ref is rejected",
          *raises(lambda: harness.validate_cases(ROOT, unknown), "unknown"))

    real = harness.load_cases(ROOT)
    check("cases: the shipped battery passes both gates",
          len(real) > 0, f"loaded {len(real)} cases")


def run_main(args: list[str], env: dict) -> int:
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run([sys.executable, str(MAIN), *args],
                          capture_output=True,
                          text=True,
                          env=merged)
    return proc.returncode


def selftest_strict_exit() -> None:
    """The deliverable: a strict run that loses a target must not be green.

    Uses --target rather than --facet so the older all-skipped facet guard
    cannot be what fires; this pins the new per-target gate on its own.
    """
    blanked = {"TRELLO_ENDPOINT": ""}
    code = run_main(["--target", "trello", "--strict"], blanked)
    check("strict: a skipped target exits non-zero", code != 0, f"exit {code}")

    code = run_main(["--target", "trello"], blanked)
    check("permissive: the same run still exits 0 for local convenience",
          code == 0, f"exit {code}")

    # The partial-skip case the facet guard cannot see: python self-hosts
    # linear, so the project facet still runs one target and ran != 0.
    code = run_main(["--facet", "project", "--strict"], blanked)
    check("strict: a facet that loses only some targets exits non-zero", code
          != 0, f"exit {code}")
    code = run_main(["--facet", "project"], blanked)
    check("permissive: that same partial facet still exits 0", code == 0,
          f"exit {code}")

    # A facet split across CI jobs declares the services it does not
    # provision; a declared skip is tolerated, a typo'd one is rejected so
    # the list cannot rot into silently widening what --strict accepts.
    code = run_main(
        ["--target", "trello", "--strict", "--allow-skip", "trello"], blanked)
    check("allow-skip: a declared skip is tolerated under --strict", code == 0,
          f"exit {code}")
    code = run_main(
        ["--target", "trello", "--strict", "--allow-skip", "nosuchsvc"],
        blanked)
    check("allow-skip: an unknown service name is rejected", code != 0,
          f"exit {code}")


def run_typescript(args: list[str], env: dict) -> tuple[int, str]:
    """Run the typescript runner, keeping stderr for the failure message.

    An unbuilt mirage package makes the runner die on import with an exit
    code that looks exactly like a gate verdict, so the tail of stderr
    rides along and says which of the two it was.

    Args:
        args (list[str]): runner arguments.
        env (dict): environment overrides; an empty value unsets.

    Returns:
        tuple: exit code and the last line of stderr.
    """
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run([str(TSX), "runners/typescript/main.ts", *args],
                          capture_output=True,
                          text=True,
                          cwd=ROOT,
                          env=merged)
    lines = [ln for ln in proc.stderr.splitlines() if ln.strip()]
    errors = [ln for ln in lines if "Error" in ln or "error" in ln]
    return proc.returncode, (errors[0] if errors else
                             (lines[-1] if lines else ""))


def selftest_typescript_gates(require: bool) -> None:
    """The same two exits on the typescript host, so the gate is symmetric.

    A silent skip here would be the very thing this file exists to catch —
    a check that reports success having run nothing — so CI passes
    --require-ts and a missing tsx is a failure rather than a skip.

    Args:
        require (bool): whether an absent tsx fails instead of skipping.
    """
    if not TSX.is_file():
        if require:
            check("typescript gates ran", False,
                  f"--require-ts given but {TSX} is missing")
            return
        print("skip typescript gates: no tsx (run pnpm install from "
              "typescript/)")
        return
    # Prove the runner starts before reading exit codes as verdicts: an
    # unbuilt mirage package dies on import with a non-zero code, which
    # would make the strict assertion below pass for the wrong reason. An
    # unknown facet exits 2 without running any case, so it costs nothing.
    code, err = run_typescript(["--facet", "__selftest_no_such_facet__"], {})
    check("typescript runner starts (packages built)", code == 2,
          f"exit {code}: {err}")

    blanked = {"TRELLO_ENDPOINT": ""}
    code, err = run_typescript(["--target", "trello", "--strict"], blanked)
    check("strict (ts): a skipped target exits non-zero", code != 0,
          f"exit {code}: {err}")
    code, err = run_typescript(["--target", "trello"], blanked)
    check("permissive (ts): the same run still exits 0", code == 0,
          f"exit {code}: {err}")


def main() -> None:
    selftest_services_table()
    selftest_case_validation()
    selftest_strict_exit()
    selftest_typescript_gates("--require-ts" in sys.argv)
    print()
    if FAILURES:
        print(f"{len(FAILURES)} gate(s) failed", file=sys.stderr)
        sys.exit(1)
    print("all integ runner gates hold")


if __name__ == "__main__":
    main()
