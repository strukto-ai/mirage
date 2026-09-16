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
import sys
from typing import Any

import yaml
from audits import audit, audit_gates, audit_invocation, audit_packages
from cases import GROUPS, Fixture
from constants import (LEG_PREFIX, MATRIX_REF, NO_LEG_DIM, NO_MATRIX, PACKAGES,
                       REPO, ROOT_MANIFEST, WORKFLOW)


def leg_scripts(manifest: dict[str, Any]) -> dict[str, str]:
    """Read the `test:leg:<name>` scripts out of the root manifest.

    Args:
        manifest (dict[str, Any]): the parsed typescript/package.json.

    Returns:
        A mapping of leg name to the script body that runs it.
    """
    scripts = manifest.get("scripts", {})
    return {
        name[len(LEG_PREFIX):]: body
        for name, body in scripts.items() if name.startswith(LEG_PREFIX)
    }


def test_matrix(workflow: dict[str, Any]) -> dict[str, Any]:
    """Reach the `test` job's matrix, naming the miss if the shape moved.

    Args:
        workflow (dict[str, Any]): the parsed test_typescript.yml.

    Returns:
        The matrix mapping.
    """
    where = str(WORKFLOW.relative_to(REPO))
    node: Any = workflow
    for key in ("jobs", "test", "strategy", "matrix"):
        if not isinstance(node, dict) or key not in node:
            raise SystemExit(NO_MATRIX.format(file=where, key=key))
        node = node[key]
    # The loop proves each container it descends INTO is a mapping, never
    # the value it lands on, so a `matrix:` written as a list reached the
    # `leg` test as a list and reported a missing dimension instead of a
    # moved shape.
    if not isinstance(node, dict):
        raise SystemExit(NO_MATRIX.format(file=where, key="matrix"))
    if "leg" not in node:
        raise SystemExit(NO_LEG_DIM.format(file=where))
    return node


def gated_steps(workflow: dict[str, Any]) -> dict[str, list[str]]:
    """Map each `matrix.<key>` a step's `if:` reads to the steps reading it.

    Args:
        workflow (dict[str, Any]): the parsed test_typescript.yml.

    Returns:
        A mapping of matrix key to the names of the steps gated on it.
    """
    gated: dict[str, list[str]] = {}
    for step in workflow["jobs"]["test"].get("steps", []):
        for key in MATRIX_REF.findall(str(step.get("if", ""))):
            gated.setdefault(key, []).append(step.get("name", "<unnamed>"))
    return gated


def package_members() -> dict[str, bool]:
    """Map each `typescript/packages/*` member to whether it has a test.

    Returns:
        Package name to whether its manifest declares a `test` script.
    """
    members: dict[str, bool] = {}
    for manifest in sorted(PACKAGES.glob("*/package.json")):
        data = json.loads(manifest.read_text())
        members[data["name"]] = "test" in data.get("scripts", {})
    return members


def run_cases(label: str, cases: tuple[Fixture, ...]) -> int:
    """Run one group of selftest fixtures.

    Args:
        label (str): the group name, printed as a heading.
        cases (tuple[Fixture, ...]): the fixtures in that group.

    Returns:
        The number of fixtures that did not behave as expected.
    """
    failures = 0
    print(f"  {label}")
    for case in cases:
        problems = case.problems()
        hit = any(case.expect in problem for problem in problems)
        if (hit and case.expect) or (not problems and not case.expect):
            print(f"    ok   {case.name}")
            continue
        failures += 1
        want = (f"a problem containing {case.expect!r}"
                if case.expect else "none")
        print(f"    FAIL {case.name}: expected {want}, got {problems}")
    return failures


def selftest() -> int:
    """Prove each refusal fires before trusting the gate to be silent.

    Returns:
        0 when every fixture is classified as expected.
    """
    failures = sum(run_cases(label, cases) for label, cases in GROUPS)
    if failures:
        print(f"\n{failures} selftest case(s) failed; the gate cannot see a "
              f"drift it claims to cover.")
        return 1
    total = sum(len(cases) for _, cases in GROUPS)
    print(f"\nselftest OK: {total} drift shapes covered")
    return 0


def main() -> int:
    """Fail when the CI leg table and the workspace have drifted apart.

    The table lives in two files -- the `test:leg:*` scripts in
    typescript/package.json carry the package selections, and the workflow
    matrix decides which of them ever run -- so a check that read only one
    would pass while a whole leg's packages went untested.

    Returns:
        0 when every package is claimed by exactly one running leg, else 1.
    """
    if "--selftest" in sys.argv[1:]:
        return selftest()

    workflow = yaml.safe_load(WORKFLOW.read_text())
    matrix = test_matrix(workflow)
    scripts = leg_scripts(json.loads(ROOT_MANIFEST.read_text()))
    declared = list(matrix["leg"])
    members = package_members()
    packages = {name for name, has in members.items() if has}
    problems = audit(scripts, declared, packages, set(members))
    problems += audit_gates(matrix, gated_steps(workflow))
    problems += audit_invocation(workflow["jobs"]["test"])
    problems += audit_packages(members)
    if problems:
        print(f"{WORKFLOW.relative_to(REPO)} and "
              f"{ROOT_MANIFEST.relative_to(REPO)} disagree:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"ok: every workspace package with a test script "
          f"({len(packages)}) is claimed by exactly one of "
          f"{len(declared)} legs ({', '.join(declared)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
