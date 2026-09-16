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

import os
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".pre-commit-config.yaml"
SETTER = ".github/workflows/pre-commit.yml"

# A hook skipped as a duplicate, and the command that has to still be
# there for that to stay true: deleting the knip step would otherwise
# leave `ts-knip` skipped with knip running nowhere, green. The command
# is matched against a step's `run:` in a job the gate requires, since
# neither a comment quoting it nor a step parked in `audit` runs it.
REPLACEMENTS = {
    "py-mypy": (".github/workflows/test_python.yml", "uv run mypy"),
    "integ-typecheck":
    (".github/workflows/test_typescript.yml", "pnpm -r --no-bail typecheck"),
    "ts-knip": (".github/workflows/test_typescript.yml", "pnpm exec knip"),
}

# Skipped for a reason other than duplication, so no replacement is owed:
# `no-commit-to-branch` is a local guard with no CI analogue, and on a
# push it would fail the job for having main checked out.
NO_REPLACEMENT = {"no-commit-to-branch"}


def declared_ids(path: Path) -> set[str]:
    """Every hook id the config declares.

    Parsed rather than grepped: the config already spells the same fact
    two ways, ``- id: x`` for twenty hooks and a bare ``id: x`` for
    ``mixed-line-ending``, whose ``name:`` comes first. A pattern has to
    know about both, and about the next variation nobody has written yet.

    Args:
        path (Path): Absolute path to ``.pre-commit-config.yaml``.

    Returns:
        set[str]: The declared ids, across every repo block.
    """
    config = yaml.safe_load(path.read_text())
    return {
        hook["id"]
        for repo in config.get("repos", [])
        for hook in repo.get("hooks", []) if "id" in hook
    }


def runs_command(step: dict[str, Any], command: str) -> bool:
    """Whether a step actually executes ``command``.

    Mentioning it is not running it, and the difference is the whole
    point of the check: a shell comment, an ``echo`` quoting it, a step
    turned off with ``if: false`` or one allowed to fail all leave the
    text in place while nothing runs. So the command has to begin a live
    line of the script.

    Args:
        step (dict[str, Any]): One parsed workflow step.
        command (str): The command text the step must invoke.

    Returns:
        bool: True when a line of the step's ``run:`` invokes it.
    """
    if step.get("continue-on-error") is True:
        return False
    if str(step.get("if", "")).strip().strip("${} ").lower() == "false":
        return False
    script = step.get("run")
    if not isinstance(script, str):
        return False
    return any(line.lstrip().startswith(command) for line in script.split("\n")
               if not line.lstrip().startswith("#"))


def covering_job(path: Path, command: str) -> str | None:
    """The job whose steps run ``command``.

    Args:
        path (Path): Absolute path to a workflow file.
        command (str): The command text a step's ``run:`` must invoke.

    Returns:
        str | None: The job's key, or None when no step runs it.
    """
    workflow: dict[str, Any] = yaml.safe_load(path.read_text())
    for name, job in workflow.get("jobs", {}).items():
        if any(runs_command(step, command) for step in job.get("steps", [])):
            return str(name)
    return None


def gated_jobs(path: Path) -> set[str]:
    """The jobs a workflow's gate refuses to pass without.

    Args:
        path (Path): Absolute path to a workflow file.

    Returns:
        set[str]: Every job named in the gate's ``needs``.
    """
    workflow = yaml.safe_load(path.read_text())
    needs = workflow.get("jobs", {}).get("gate", {}).get("needs", [])
    return {needs} if isinstance(needs, str) else set(needs)


def missing_replacement(hook_id: str) -> str | None:
    """Why a skipped hook's promised replacement does not hold.

    Args:
        hook_id (str): An id named in SKIP.

    Returns:
        str | None: A one-line reason, or None when the skip is covered
        or is one the map says is owed no replacement.
    """
    if hook_id in NO_REPLACEMENT:
        return None
    if hook_id not in REPLACEMENTS:
        return (f"is skipped but named in neither REPLACEMENTS nor "
                f"NO_REPLACEMENT in {Path(__file__).name}. Say which "
                f"workflow runs it instead, or why nothing needs to.")
    workflow, command = REPLACEMENTS[hook_id]
    path = ROOT / workflow
    if not path.exists():
        return f"is skipped for {workflow}, which no longer exists"
    job = covering_job(path, command)
    if job is None:
        return (f"is skipped because {workflow} runs {command!r}, and no "
                f"step there runs it any more")
    gated = gated_jobs(path)
    if not gated:
        return (f"is skipped for {workflow}, which no longer has a gate job "
                f"naming what it requires, so nothing there blocks a merge")
    if job not in gated:
        return (f"is skipped because {workflow} runs {command!r}, which now "
                f"sits in job {job!r} -- a job that workflow's gate does not "
                f"require, so a failure there no longer blocks a merge")
    return None


def main() -> int:
    """Refuse a SKIP entry that names no hook.

    pre-commit reads SKIP as an opaque comma list and checks membership
    against nothing, so renaming a hook makes its skip stop matching in
    silence and CI quietly pays for the duplicate run again. Nothing goes
    red, which is why this has to be asserted rather than noticed.

    Returns:
        int: 0 when every named id is declared, 1 otherwise.
    """
    named = [s.strip() for s in os.environ.get("SKIP", "").split(",")]
    named = [s for s in named if s]
    if not named:
        print(f"SKIP hooks check FAILED\n\nSKIP is empty or unset. {SETTER} "
              "sets it to the hooks other workflows already run; an empty "
              "value means that list was lost, not that nothing is skipped.")
        return 1

    skipped = set(named)
    declared = declared_ids(CONFIG)
    problems = [
        f"{hook_id!r} is named in SKIP, but no hook declares it"
        for hook_id in sorted(skipped - declared)
    ]
    problems += [
        f"{hook_id!r} {reason}" for hook_id in sorted(skipped & declared)
        if (reason := missing_replacement(hook_id)) is not None
    ]
    if problems:
        print("SKIP hooks check FAILED\n")
        for problem in problems:
            print(problem)
        print(f"\nSKIP is set in {SETTER}; ids are declared in "
              f"{CONFIG.relative_to(ROOT)}. A hook skipped here is a promise "
              f"that another workflow still runs it -- keep both sides, or "
              f"drop the skip.")
        return 1

    print(f"SKIP hooks OK: {len(skipped)} skipped id(s) declared and covered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
