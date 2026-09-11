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
"""The config-plane suite: one snake_case block through both registries.

Every other integ case is a shell line run against a mount the runner
built by hand in its own idiom, so the door a YAML block actually comes
through -- ``build_resource`` here, ``buildResource`` in
``integ/config/run.ts`` -- was exercised by nothing. This suite hands the
same mapping to that door on both hosts and compares what came out: the
redacted snapshot state for a config both must accept, or the refusal's
``<resource>: <field>`` prefix for one both must refuse. Keys are compared
in python's wire spelling; the TypeScript runner folds its camelCase state
back through the rename map the spec dump records.
"""
import asyncio
import inspect
import json
import sys
from pathlib import Path
from typing import Any

from mirage.resource.registry import build_resource

HOST = "python"
SUITE = Path(__file__).parent / "cases.json"


def _problems(case: dict[str, Any], state: dict[str, Any] | None,
              error: str | None) -> list[str]:
    """Judge one case's outcome against its expectation.

    Args:
        case (dict[str, Any]): the case as written in ``cases.json``.
        state (dict[str, Any] | None): the built resource's redacted
            config, or None when the build refused.
        error (str | None): the refusal message, or None when it built.

    Returns:
        list[str]: one line per mismatch, empty when the case passed.
    """
    expect = case["expect"]
    label = f"config/{case['id']}"
    if "refused" in expect:
        if error is None:
            return [
                f"{label}: expected a refusal containing "
                f"{expect['refused']!r}, but the config was accepted"
            ]
        if expect["refused"] not in error:
            return [
                f"{label}: refusal {error!r} does not contain "
                f"{expect['refused']!r}"
            ]
        return []
    if error is not None:
        return [
            f"{label}: expected the config to be accepted, "
            f"refused with {error!r}"
        ]
    assert state is not None
    out = []
    for key, want in expect.get("state", {}).items():
        if key not in state:
            out.append(f"{label}: state lacks {key!r}")
        elif state[key] != want:
            out.append(f"{label}: state[{key!r}] = {state[key]!r}, "
                       f"expected {want!r}")
    for key in expect.get("absent", []):
        if key in state:
            out.append(f"{label}: state carries {key!r} = {state[key]!r}, "
                       "expected it dropped")
    return out


async def _run(case: dict[str, Any]) -> list[str]:
    try:
        resource = build_resource(case["resource"], dict(case["config"]))
    except Exception as exc:
        return _problems(case, None, str(exc))
    state = resource.get_state()
    if inspect.isawaitable(state):
        state = await state
    close = getattr(resource, "close", None)
    if close is not None:
        closed = close()
        if inspect.isawaitable(closed):
            await closed
    config = state.get("config") if isinstance(state, dict) else None
    if not isinstance(config, dict):
        return [f"config/{case['id']}: state carries no config mapping"]
    return _problems(case, config, None)


async def main() -> int:
    suite = json.loads(SUITE.read_text())
    passed = 0
    failures: list[str] = []
    for case in suite["cases"]:
        if HOST not in case.get("hosts", ["python", "typescript"]):
            continue
        problems = await _run(case)
        if problems:
            failures.extend(problems)
            print(f"FAIL config/{case['id']}")
        else:
            passed += 1
            print(f"ok config/{case['id']}")
    print(f"\n{passed} passed, {len(failures)} failed")
    for line in failures:
        print(f"  {line}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
