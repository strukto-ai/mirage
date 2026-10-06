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

from dataclasses import asdict
from typing import Any

from mirage.io.types import IOResult
from mirage.policy.types import Ask, Deny, Explanation, Route
from mirage.types import JsonValue


async def io_result_to_dict(result: IOResult | None) -> dict[str, Any]:
    """Materialize an IOResult into a JSON-friendly dict.

    Args:
        result (IOResult | None): the workspace.shell return value.

    Returns:
        dict[str, Any]: serializable response payload.
    """
    if isinstance(result, IOResult):
        stdout = await result.materialize_stdout()
        stderr = await result.materialize_stderr()
        return {
            "kind": "io",
            "exit_code": result.exit_code,
            "stdout": stdout.decode(errors="replace"),
            "stderr": stderr.decode(errors="replace"),
            "refusal": (
                asdict(result.refusal) if result.refusal is not None else None
            ),
        }
    return {"kind": "raw", "value": str(result)}


def explanation_to_dict(expl: Explanation) -> dict[str, JsonValue]:
    """An explanation as the server's doors answer it.

    Args:
        expl (Explanation): what one command or one op would do.

    Returns:
        dict[str, JsonValue]: serializable response payload.
    """
    return {
        "command": expl.command,
        "argv": list(expl.argv),
        "outcome": expl.outcome.value,
        "reason": expl.reason,
        "source": expl.source,
        "matched_path": expl.matched_path,
        "paths": list(expl.paths),
        "exit_code": expl.exit_code,
        "stderr": expl.stderr,
        "refusal": asdict(expl.refusal) if expl.refusal is not None else None,
        "answers": [answer_to_dict(a) for a in expl.answers],
        "placement": [answer_to_dict(a) for a in expl.placement],
        "runtime": expl.runtime,
        "error": expl.error,
    }


def answer_to_dict(action: Deny | Ask | Route) -> dict[str, JsonValue]:
    """One policy's answer as the server's doors carry it.

    Args:
        action (Deny | Ask | Route): the answer.
    """
    if isinstance(action, Route):
        return {
            "kind": "route",
            "runtime": action.runtime,
            "policy": action.policy,
        }
    return {
        "kind": action.kind,
        "reason": action.reason,
        "policy": action.policy,
    }
