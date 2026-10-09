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

import base64
import binascii
from collections.abc import Mapping
from dataclasses import asdict
from typing import Any

import jsonschema

from mirage.errors.classify import classify
from mirage.errors.posix import posix_phrase
from mirage.io.types import IOResult
from mirage.policy.errors import PolicyDenied
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
from mirage.server.vfs_calls import BYTES, Args, VfsCall, schema_of
from mirage.types import FileStat, JsonValue, Refusal
from mirage.workspace.workspace.workspace import Session


class CallArgsError(ValueError):
    """A VFS call's arguments do not fit its schema."""


def refusal_to_dict(refusal: Refusal | None) -> dict[str, JsonValue] | None:
    """A refusal record as the server's entry points carry it.

    Args:
        refusal (Refusal | None): the record, or None when nothing was
            refused.
    """
    return asdict(refusal) if refusal is not None else None


def failure_to_dict(exc: Exception) -> dict[str, JsonValue]:
    """A failed call's public detail, errno and policy refusal record.

    Only named conditions have public text. Unknown exceptions may carry
    credentials, backend responses or host paths, so keep their details
    in the server's logs.

    Args:
        exc (Exception): what the call raised.
    """
    condition = classify(exc)
    body: dict[str, JsonValue] = {
        "detail": (
            "internal server error"
            if condition is None
            else posix_phrase(condition)
        )
    }
    if condition is not None:
        body["errno"] = condition.name
    if isinstance(exc, PolicyDenied):
        body["refusal"] = refusal_to_dict(exc.refusal)
    return body


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
    """An explanation as the server's entry points answer it: a line with its
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
    """One node of a line's tree as the entry points carry it.

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
    """One policy's answer as the server's entry points carry it.

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


def checked(call: VfsCall, params: Mapping[str, JsonValue]) -> dict[str, Any]:
    """A VFS call's arguments, held to its schema, as its method takes
    them: each ``<name>_base64`` decoded to the bytes ``<name>`` takes.

    Args:
        call (VfsCall): the call.
        params (Mapping[str, JsonValue]): the arguments as JSON.

    Raises:
        CallArgsError: the arguments do not fit the schema.
    """
    try:
        jsonschema.validate(dict(params), schema_of(call))
    except jsonschema.ValidationError as exc:
        raise CallArgsError(
            f"invalid arguments for vfs/{call.name}: {exc.message}"
        ) from exc
    args: dict[str, Any] = {}
    for name, value in params.items():
        if call.params[name] is not BYTES:
            args[name] = value
            continue
        try:
            args[name.removesuffix("_base64")] = base64.b64decode(
                str(value), validate=True
            )
        except (binascii.Error, ValueError) as exc:
            raise CallArgsError(f"{name} must be base64") from exc
    return args


def _to_json(value: Any) -> JsonValue:
    if isinstance(value, bytes):
        return base64.b64encode(value).decode()
    if isinstance(value, FileStat):
        return value.model_dump(mode="json", exclude={"extra"})
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (list, tuple)):
        return list(value)
    if isinstance(value, (str, bool)):
        return value
    raise TypeError(f"no JSON form for {type(value).__name__}")


async def answered(
    session: Session, call: VfsCall, args: Args, explain: bool
) -> JsonValue:
    """Run a VFS call as a session, or explain it, and answer it as JSON.

    Args:
        session (Session): the session the call acts as.
        call (VfsCall): the call.
        args (Args): its arguments, as :func:`checked` returns them.
        explain (bool): answer what the call would do instead of doing
            it (``session.explain.vfs``).
    """
    target = session.explain.vfs if explain else session.vfs
    result = await getattr(target, call.name)(**args)
    if explain:
        return explanation_to_dict(result)
    return {} if call.answer is None else {call.answer: _to_json(result)}
