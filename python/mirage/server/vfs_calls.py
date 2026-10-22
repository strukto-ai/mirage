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

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from mirage.types import JsonValue

Args = Mapping[str, Any]
Schema = dict[str, JsonValue]

PATH: Schema = {"type": "string"}
TEXT: Schema = {"type": "string"}
BYTES: Schema = {"type": "string", "contentEncoding": "base64"}
INTEGER: Schema = {"type": "integer"}
SIZE: Schema = {"type": ["integer", "null"]}
FLAG: Schema = {"type": "boolean"}
OWNER: Schema = {"type": ["integer", "string"]}
PATH_ONLY: dict[str, Schema] = {"path": PATH}


@dataclass(frozen=True, slots=True)
class VfsCall:
    """One ``session.vfs`` call as the remote endpoints carry it. An endpoint
    calls the method of the same name on ``session.vfs``, or on
    ``session.explain.vfs`` to explain it, passing each argument by name,
    and answers what it returns. Bytes travel as base64, both ways.

    Args:
        name (str): the call's name; ``vfs/<name>`` on every entry point.
        description (str): what the call does, in one line.
        params (Mapping[str, Schema]): each argument's JSON schema, in
            the order the call takes them.
        required (tuple[str, ...]): the arguments it cannot do without.
    """

    name: str
    description: str
    params: Mapping[str, Schema]
    required: tuple[str, ...]


VFS_CALLS: tuple[VfsCall, ...] = (
    VfsCall(
        "read",
        "Read a file's bytes, from an offset.",
        {"path": PATH, "offset": INTEGER, "size": SIZE},
        ("path",),
    ),
    VfsCall(
        "write",
        "Write a file's bytes, replacing what it held.",
        {"path": PATH, "data": BYTES},
        ("path", "data"),
    ),
    VfsCall(
        "append",
        "Append bytes to a file.",
        {"path": PATH, "data": BYTES},
        ("path", "data"),
    ),
    VfsCall(
        "pwrite",
        "Write bytes into a file at an offset.",
        {"path": PATH, "data": BYTES, "offset": INTEGER},
        ("path", "data", "offset"),
    ),
    VfsCall(
        "stat",
        "A path's metadata.",
        {"path": PATH, "nofollow": FLAG},
        ("path",),
    ),
    VfsCall(
        "readdir",
        "A directory's entries.",
        PATH_ONLY,
        ("path",),
    ),
    VfsCall("exists", "Whether a path exists.", PATH_ONLY, ("path",)),
    VfsCall(
        "is_dir",
        "Whether a path is a directory.",
        PATH_ONLY,
        ("path",),
    ),
    VfsCall(
        "is_file",
        "Whether a path is a file.",
        PATH_ONLY,
        ("path",),
    ),
    VfsCall(
        "list_files",
        "The names of a directory's files.",
        PATH_ONLY,
        ("path",),
    ),
    VfsCall("mkdir", "Make a directory.", PATH_ONLY, ("path",)),
    VfsCall("rmdir", "Remove an empty directory.", PATH_ONLY, ("path",)),
    VfsCall("unlink", "Remove a file.", PATH_ONLY, ("path",)),
    VfsCall("create", "Create an empty file.", PATH_ONLY, ("path",)),
    VfsCall(
        "rename",
        "Rename a path within its mount.",
        {"src": PATH, "dst": PATH},
        ("src", "dst"),
    ),
    VfsCall(
        "symlink",
        "Make a symbolic link at a path.",
        {"path": PATH, "target": TEXT},
        ("path", "target"),
    ),
    VfsCall(
        "readlink",
        "Where a symbolic link points.",
        PATH_ONLY,
        ("path",),
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
    ),
    VfsCall(
        "getxattr",
        "One extended attribute's value.",
        {"path": PATH, "name": TEXT, "nofollow": FLAG},
        ("path", "name"),
    ),
    VfsCall(
        "listxattr",
        "A path's extended attribute names.",
        {"path": PATH, "nofollow": FLAG},
        ("path",),
    ),
    VfsCall(
        "setxattr",
        "Set an extended attribute.",
        {
            "path": PATH,
            "name": TEXT,
            "value": BYTES,
            "create": FLAG,
            "replace": FLAG,
            "nofollow": FLAG,
        },
        ("path", "name", "value"),
    ),
    VfsCall(
        "removexattr",
        "Remove an extended attribute.",
        {"path": PATH, "name": TEXT, "nofollow": FLAG},
        ("path", "name"),
    ),
    VfsCall(
        "truncate",
        "Cut or extend a file to a length.",
        {"path": PATH, "length": INTEGER},
        ("path", "length"),
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
