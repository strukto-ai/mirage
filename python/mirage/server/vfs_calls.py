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
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

import jsonschema

from mirage.ops.ops import Ops
from mirage.server.io_serde import explanation_to_dict
from mirage.types import FileStat, JsonValue
from mirage.workspace.workspace.explainer import VfsExplainer
from mirage.workspace.workspace.handle import Session

Args = Mapping[str, Any]
Schema = dict[str, JsonValue]
Answer = dict[str, JsonValue]

PATH: Schema = {"type": "string"}
TEXT: Schema = {"type": "string"}
BYTES: Schema = {"type": "string", "contentEncoding": "base64"}
INTEGER: Schema = {"type": "integer"}
SIZE: Schema = {"type": ["integer", "null"]}
FLAG: Schema = {"type": "boolean"}
OWNER: Schema = {"type": ["integer", "string"]}


class CallArgsError(ValueError):
    """A call's arguments do not fit its schema."""


@dataclass(frozen=True, slots=True)
class VfsCall:
    """One ``session.vfs`` call as the remote doors carry it: its
    arguments as JSON, the call they make, and its answer as JSON. The
    same call runs on ``session.explain.vfs``, whose signatures are the
    same, when the caller asks to explain it.

    Args:
        name (str): the call's name; ``vfs/<name>`` on every door.
        description (str): what the call does, in one line.
        params (Mapping[str, Schema]): each argument's JSON schema, in
            the order the call takes them.
        required (tuple[str, ...]): the arguments it cannot do without.
        run (Callable[[Ops | VfsExplainer, Args], Awaitable[Any]]): the call, on
            ``session.vfs`` or ``session.explain.vfs``.
        answer (Callable[[Any], Answer]): its result as JSON.
    """

    name: str
    description: str
    params: Mapping[str, Schema]
    required: tuple[str, ...]
    run: Callable[[Ops | VfsExplainer, Args], Awaitable[Any]]
    answer: Callable[[Any], Answer]


def _none(result: None) -> Answer:
    return {}


def _stat(stat: FileStat) -> Answer:
    return stat.model_dump(mode="json", exclude={"extra"})


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


VFS_CALLS: tuple[VfsCall, ...] = (
    VfsCall(
        "read",
        "Read a file's bytes, from an offset.",
        {"path": PATH, "offset": INTEGER, "size": SIZE},
        ("path",),
        lambda v, a: v.read(a["path"], a.get("offset", 0), a.get("size")),
        lambda data: {"data_base64": _b64(data)},
    ),
    VfsCall(
        "write",
        "Write a file's bytes, replacing what it held.",
        {"path": PATH, "data_base64": BYTES},
        ("path", "data_base64"),
        lambda v, a: v.write(a["path"], a["data_base64"]),
        _none,
    ),
    VfsCall(
        "append",
        "Append bytes to a file.",
        {"path": PATH, "data_base64": BYTES},
        ("path", "data_base64"),
        lambda v, a: v.append(a["path"], a["data_base64"]),
        _none,
    ),
    VfsCall(
        "pwrite",
        "Write bytes into a file at an offset.",
        {"path": PATH, "data_base64": BYTES, "offset": INTEGER},
        ("path", "data_base64", "offset"),
        lambda v, a: v.pwrite(a["path"], a["data_base64"], a["offset"]),
        _none,
    ),
    VfsCall(
        "stat",
        "A path's metadata.",
        {"path": PATH, "nofollow": FLAG},
        ("path",),
        lambda v, a: v.stat(a["path"], nofollow=a.get("nofollow", False)),
        _stat,
    ),
    VfsCall(
        "readdir",
        "A directory's entries.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.readdir(a["path"]),
        lambda names: {"entries": list(names)},
    ),
    VfsCall(
        "exists",
        "Whether a path exists.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.exists(a["path"]),
        lambda found: {"exists": found},
    ),
    VfsCall(
        "is_dir",
        "Whether a path is a directory.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.is_dir(a["path"]),
        lambda found: {"is_dir": found},
    ),
    VfsCall(
        "is_file",
        "Whether a path is a file.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.is_file(a["path"]),
        lambda found: {"is_file": found},
    ),
    VfsCall(
        "cat",
        "A file's text.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.cat(a["path"]),
        lambda text: {"text": text},
    ),
    VfsCall(
        "list_files",
        "The names of a directory's files.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.list_files(a["path"]),
        lambda names: {"files": list(names)},
    ),
    VfsCall(
        "mkdir",
        "Make a directory.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.mkdir(a["path"]),
        _none,
    ),
    VfsCall(
        "rmdir",
        "Remove an empty directory.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.rmdir(a["path"]),
        _none,
    ),
    VfsCall(
        "unlink",
        "Remove a file.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.unlink(a["path"]),
        _none,
    ),
    VfsCall(
        "create",
        "Create an empty file.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.create(a["path"]),
        _none,
    ),
    VfsCall(
        "rename",
        "Rename a path within its mount.",
        {"src": PATH, "dst": PATH},
        ("src", "dst"),
        lambda v, a: v.rename(a["src"], a["dst"]),
        _none,
    ),
    VfsCall(
        "symlink",
        "Make a symbolic link at a path.",
        {"path": PATH, "target": TEXT},
        ("path", "target"),
        lambda v, a: v.symlink(a["path"], a["target"]),
        _none,
    ),
    VfsCall(
        "readlink",
        "Where a symbolic link points.",
        {"path": PATH},
        ("path",),
        lambda v, a: v.readlink(a["path"]),
        lambda target: {"target": target},
    ),
    VfsCall(
        "setattr",
        "Change a path's mode, owner or times.",
        {
            "path": PATH,
            "mode": INTEGER,
            "uid": OWNER,
            "gid": OWNER,
            "atime": TEXT,
            "mtime": TEXT,
            "nofollow": FLAG,
        },
        ("path",),
        lambda v, a: v.setattr(
            a["path"],
            mode=a.get("mode"),
            uid=a.get("uid"),
            gid=a.get("gid"),
            atime=a.get("atime"),
            mtime=a.get("mtime"),
            nofollow=a.get("nofollow", False),
        ),
        lambda changed: {"changed": dict(changed)},
    ),
    VfsCall(
        "getxattr",
        "One extended attribute's value.",
        {"path": PATH, "name": TEXT, "nofollow": FLAG},
        ("path", "name"),
        lambda v, a: v.getxattr(
            a["path"], a["name"], nofollow=a.get("nofollow", False)
        ),
        lambda value: {"value_base64": _b64(value)},
    ),
    VfsCall(
        "listxattr",
        "A path's extended attribute names.",
        {"path": PATH, "nofollow": FLAG},
        ("path",),
        lambda v, a: v.listxattr(a["path"], nofollow=a.get("nofollow", False)),
        lambda names: {"names": list(names)},
    ),
    VfsCall(
        "setxattr",
        "Set an extended attribute.",
        {
            "path": PATH,
            "name": TEXT,
            "value_base64": BYTES,
            "create": FLAG,
            "replace": FLAG,
            "nofollow": FLAG,
        },
        ("path", "name", "value_base64"),
        lambda v, a: v.setxattr(
            a["path"],
            a["name"],
            a["value_base64"],
            create=a.get("create", False),
            replace=a.get("replace", False),
            nofollow=a.get("nofollow", False),
        ),
        _none,
    ),
    VfsCall(
        "removexattr",
        "Remove an extended attribute.",
        {"path": PATH, "name": TEXT, "nofollow": FLAG},
        ("path", "name"),
        lambda v, a: v.removexattr(
            a["path"], a["name"], nofollow=a.get("nofollow", False)
        ),
        _none,
    ),
    VfsCall(
        "truncate",
        "Cut or extend a file to a length.",
        {"path": PATH, "length": INTEGER},
        ("path", "length"),
        lambda v, a: v.truncate(a["path"], a["length"]),
        _none,
    ),
)

VFS_CALL_BY_NAME: dict[str, VfsCall] = {call.name: call for call in VFS_CALLS}


def schema_of(call: VfsCall) -> Schema:
    """A call's arguments as one JSON object schema.

    Args:
        call (VfsCall): the call.
    """
    return {
        "type": "object",
        "properties": dict(call.params),
        "required": list(call.required),
        "additionalProperties": False,
    }


def checked(call: VfsCall, params: Mapping[str, JsonValue]) -> dict[str, Any]:
    """A call's arguments, held to its schema, with every base64
    argument decoded to bytes.

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
    args: dict[str, Any] = dict(params)
    for name, schema in call.params.items():
        if schema is BYTES and name in args:
            try:
                args[name] = base64.b64decode(args[name], validate=True)
            except (binascii.Error, ValueError) as exc:
                raise CallArgsError(f"{name} must be base64") from exc
    return args


async def answered(
    session: Session, call: VfsCall, args: Args, explain: bool
) -> JsonValue:
    """Run a call as a session, or explain it, and answer it as JSON.

    Args:
        session (Session): the session the call acts as.
        call (VfsCall): the call.
        args (Args): its arguments, as :func:`checked` returns them.
        explain (bool): answer what the call would do instead of
            doing it (``session.explain.vfs``).
    """
    if explain:
        return explanation_to_dict(await call.run(session.explain.vfs, args))
    return call.answer(await call.run(session.vfs, args))
