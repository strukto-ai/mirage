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

import shlex
from typing import Any

from constants import (BAD_PACKAGE, CLOSURE_FILTER, DOUBLE_CLAIM,
                       DOUBLE_FILTER, FALSY_GATE, FILTER, JOB_MAY_FAIL,
                       LEG_PREFIX, NO_LEG_SCRIPT, NO_LIVE_STEP, NO_TEST_SCRIPT,
                       NO_TEST_WHY, SCRIPT_UNUSED, STRAY_INCLUDE, UNCLAIMED,
                       UNKNOWN_WHY, UNSET_GATE, WRONG_VERB)


def package_of(token: str) -> str:
    """Reduce a `--filter` token to the package name it selects.

    `strip` is the wrong tool for pnpm's `...pkg` closure syntax: it would
    eat the leading dot of a path selector like `./packages/core`.

    Args:
        token (str): one whitespace-delimited word following `--filter`.

    Returns:
        The package name, without quoting or closure syntax.
    """
    name = token.strip("\"'")
    return name.removeprefix("...").removesuffix("...")


def invoked_script(body: str) -> str | None:
    """Name the npm script a leg body actually runs.

    Tokenised rather than pattern-matched: `-` and `:` are regex word
    boundaries, so a pattern loose enough to accept the repo's own
    `pnpm ... test` spelling also accepts `run test:unit`. A chained body
    returns None rather than being segmented, since the point is to name
    one script.

    Args:
        body (str): the script body from typescript/package.json.

    Returns:
        The script name, or None when the body chains or invokes nothing.
    """
    if any(sep in body for sep in ("&&", ";", "|")):
        return None
    words = shlex.split(body)
    if "run" in words:
        rest = words[words.index("run") + 1:]
        return rest[0] if rest else None
    return words[-1] if words else None


def audit_packages(members: dict[str, bool]) -> list[str]:
    """Refuse a `packages/*` member that declares no `test` script.

    Such a member is not merely unclaimed by a leg: `pnpm.requiredScripts`
    makes `pnpm test` fail outright for every developer.

    Args:
        members (dict[str, bool]): package name to whether it has a test.

    Returns:
        One line per member missing a test script.
    """
    return [
        NO_TEST_SCRIPT.format(name=name)
        for name, has_test in sorted(members.items()) if not has_test
    ]


def runs_command(step: dict[str, Any], command: str) -> bool:
    """Whether a step actually executes `command`.

    Mentioning it is not running it: a shell comment, an `echo` quoting it,
    a step turned off with `if: false` or one allowed to fail all leave the
    text in place while nothing runs. Same shape as `check_skip_hooks.py`.

    Args:
        step (dict[str, Any]): one parsed workflow step.
        command (str): the command text the step must invoke.

    Returns:
        True when a live line of the step's `run:` invokes it.
    """
    if step.get("continue-on-error") is True:
        return False
    if str(step.get("if", "")).strip().strip("${} ").lower() == "false":
        return False
    script = step.get("run")
    if not isinstance(script, str):
        return False
    for line in script.split("\n"):
        text = line.lstrip()
        if not text.startswith("#") and text.startswith("pnpm"):
            if command in text:
                return True
    return False


def audit_invocation(job: dict[str, Any]) -> list[str]:
    """Check that the job really runs the leg script the matrix selects.

    Everything else here assumes the workflow invokes the selected leg and
    lets it fail the run. Deleting the step, hardcoding one leg, disabling
    it or marking it allowed-to-fail each leave a green gate over a job
    that tested nothing.

    Args:
        job (dict[str, Any]): the parsed `test` job.

    Returns:
        One line per way the invocation is absent or defanged.
    """
    wanted = LEG_PREFIX + "${{ matrix.leg }}"
    problems: list[str] = []
    if job.get("continue-on-error") is True:
        problems.append(JOB_MAY_FAIL)
    if not any(runs_command(step, wanted) for step in job.get("steps", [])):
        problems.append(NO_LIVE_STEP.format(wanted=wanted))
    return problems


def audit_gates(matrix: dict[str, Any], gated: dict[str,
                                                    list[str]]) -> list[str]:
    """Check every `if: matrix.<key>` step against the include rows.

    Bare truthiness on an absent key is false everywhere, so mistyping
    `examples:` as `example:` deletes a whole battery and leaves the run
    green.

    Args:
        matrix (dict[str, Any]): the `test` job's matrix.
        gated (dict[str, list[str]]): matrix key to the steps gated on it.

    Returns:
        One line per key that is read but never set, or set but never read.
    """
    dims = {key for key in matrix if key != "include"}
    declared = set(matrix["leg"])
    provided: dict[str, list[str]] = {}
    problems: list[str] = []
    for row in matrix.get("include", []):
        leg = row.get("leg")
        if leg is not None and leg not in declared:
            problems.append(
                STRAY_INCLUDE.format(leg=leg,
                                     legs=", ".join(matrix["leg"]),
                                     lost=", ".join(sorted(set(row) - {"leg"}))
                                     or "nothing"))
        for key, value in row.items():
            if key in dims:
                continue
            if not value:
                problems.append(
                    FALSY_GATE.format(key=key,
                                      value=value,
                                      where=f"leg {leg}"
                                      if leg is not None else "every leg"))
            provided.setdefault(
                key, []).append(str(leg) if leg is not None else "all")

    for key, steps in sorted(gated.items()):
        if key in dims or key in provided:
            continue
        problems.append(UNSET_GATE.format(steps=", ".join(steps), key=key))
    return problems


def audit(scripts: dict[str, str], declared: list[str], packages: set[str],
          known: set[str]) -> list[str]:
    """Compare the two halves of the leg table against the workspace.

    Args:
        scripts (dict[str, str]): leg name to `test:leg:*` script body.
        declared (list[str]): the leg names the workflow matrix runs.
        packages (set[str]): workspace members that declare a test script.
        known (set[str]): every workspace member, testable or not.

    Returns:
        One human-readable line per disagreement, empty when they agree.
    """
    problems: list[str] = []
    for leg in declared:
        if leg not in scripts:
            problems.append(NO_LEG_SCRIPT.format(leg=leg, prefix=LEG_PREFIX))
    for leg in declared:
        body = scripts.get(leg)
        if body is None:
            continue
        ran = invoked_script(body)
        if ran != "test":
            problems.append(
                WRONG_VERB.format(
                    prefix=LEG_PREFIX,
                    leg=leg,
                    ran=ran or "no single script (the body chains commands)"))
    for leg in scripts:
        if leg not in declared:
            problems.append(SCRIPT_UNUSED.format(prefix=LEG_PREFIX, leg=leg))

    claims: dict[str, list[str]] = {}
    for leg in declared:
        seen: set[str] = set()
        for token in FILTER.findall(scripts.get(leg, "")):
            if "..." in token:
                problems.append(CLOSURE_FILTER.format(leg=leg, token=token))
            name = package_of(token)
            if name in seen:
                problems.append(DOUBLE_FILTER.format(leg=leg, name=name))
                continue
            seen.add(name)
            claims.setdefault(name, []).append(leg)

    for name, legs in sorted(claims.items()):
        if name not in packages:
            problems.append(
                BAD_PACKAGE.format(
                    legs=", ".join(sorted(legs)),
                    name=name,
                    why=NO_TEST_WHY if name in known else UNKNOWN_WHY))
        elif len(legs) > 1:
            problems.append(
                DOUBLE_CLAIM.format(name=name, legs=", ".join(sorted(legs))))
    for name in sorted(packages - set(claims)):
        problems.append(UNCLAIMED.format(name=name))
    return problems
