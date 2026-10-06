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
from mirage.policy.types import (
    Ask,
    CommandExplanation,
    Deny,
    Explanation,
    Route,
    ShellExplanation,
    ShellNode,
    VfsExplanation,
)
from mirage.types import JsonValue, Refusal


def refusal_to_dict(refusal: Refusal | None) -> dict[str, JsonValue] | None:
    """A refusal record as the server's doors carry it.

    Args:
        refusal (Refusal | None): the record, or None when nothing was
            refused.
    """
    return asdict(refusal) if refusal is not None else None


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
            "refusal": refusal_to_dict(result.refusal),
        }
    return {"kind": "raw", "value": str(result)}


def explanation_to_dict(expl: Explanation) -> dict[str, JsonValue]:
    """An explanation as the server's doors answer it: a line with its
    tree (``shell`` explained) or a VFS call (``vfs/<call>`` explained).

    Args:
        expl (Explanation): what a line or a VFS call would do.

    Returns:
        dict[str, JsonValue]: serializable response payload.
    """
    verdict: dict[str, JsonValue] = {
        "outcome": expl.outcome.value,
        "reason": expl.reason,
        "source": expl.source,
        "refusal": refusal_to_dict(expl.refusal),
        "answers": [answer_to_dict(a) for a in expl.answers],
    }
    if isinstance(expl, ShellExplanation):
        return {
            "line": expl.line,
            **verdict,
            "exit_code": expl.exit_code,
            "stderr": expl.stderr,
            "node": _node_to_dict(expl.node),
        }
    if isinstance(expl, VfsExplanation):
        return {
            "call": expl.call,
            "paths": list(expl.paths),
            **verdict,
            "error": expl.error,
        }
    if isinstance(expl, CommandExplanation):
        return {
            "type": expl.type,
            "text": expl.text,
            "command": expl.command,
            "argv": list(expl.argv),
            **verdict,
            "exit_code": expl.exit_code,
            "stderr": expl.stderr,
            "runtime": expl.runtime,
            "operands": [
                {"text": o.text, "path": o.path, "matched": o.matched}
                for o in expl.operands
            ],
            "children": [_node_to_dict(c) for c in expl.children],
        }
    return verdict


def _node_to_dict(
    node: ShellNode | CommandExplanation,
) -> dict[str, JsonValue]:
    """One node of a line's tree as the doors carry it.

    Args:
        node (ShellNode | CommandExplanation): the node.
    """
    if isinstance(node, CommandExplanation):
        return explanation_to_dict(node)
    return {
        "type": node.type,
        "text": node.text,
        "children": [_node_to_dict(c) for c in node.children],
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
