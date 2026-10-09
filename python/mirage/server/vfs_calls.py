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
    ``session.explain.vfs`` to explain it, passing each argument by name;
    ``<name>_base64`` carries the bytes ``<name>`` takes.

    Args:
        name (str): the call's name; ``vfs/<name>`` on every entry point.
        description (str): what the call does, in one line.
        params (Mapping[str, Schema]): each argument's JSON schema, in
            the order the call takes them.
        required (tuple[str, ...]): the arguments it cannot do without.
        answer (str | None): the key its result is answered under; None
            for a call that answers nothing.
    """

    name: str
    description: str
    params: Mapping[str, Schema]
    required: tuple[str, ...]
    answer: str | None


VFS_CALLS: tuple[VfsCall, ...] = (
    VfsCall(
        "read",
        "Read a file's bytes, from an offset.",
        {"path": PATH, "offset": INTEGER, "size": SIZE},
        ("path",),
        "data_base64",
    ),
    VfsCall(
        "write",
        "Write a file's bytes, replacing what it held.",
        {"path": PATH, "data_base64": BYTES},
        ("path", "data_base64"),
        None,
    ),
    VfsCall(
        "append",
        "Append bytes to a file.",
        {"path": PATH, "data_base64": BYTES},
        ("path", "data_base64"),
        None,
    ),
    VfsCall(
        "pwrite",
        "Write bytes into a file at an offset.",
        {"path": PATH, "data_base64": BYTES, "offset": INTEGER},
        ("path", "data_base64", "offset"),
        None,
    ),
    VfsCall(
        "stat",
        "A path's metadata.",
        {"path": PATH, "nofollow": FLAG},
        ("path",),
        "stat",
    ),
    VfsCall(
        "readdir",
        "A directory's entries.",
        PATH_ONLY,
        ("path",),
        "entries",
    ),
    VfsCall(
        "exists", "Whether a path exists.", PATH_ONLY, ("path",), "exists"
    ),
    VfsCall(
        "is_dir",
        "Whether a path is a directory.",
        PATH_ONLY,
        ("path",),
        "is_dir",
    ),
    VfsCall(
        "is_file",
        "Whether a path is a file.",
        PATH_ONLY,
        ("path",),
        "is_file",
    ),
    VfsCall("cat", "A file's text.", PATH_ONLY, ("path",), "text"),
    VfsCall(
        "list_files",
        "The names of a directory's files.",
        PATH_ONLY,
        ("path",),
        "files",
    ),
    VfsCall("mkdir", "Make a directory.", PATH_ONLY, ("path",), None),
    VfsCall("rmdir", "Remove an empty directory.", PATH_ONLY, ("path",), None),
    VfsCall("unlink", "Remove a file.", PATH_ONLY, ("path",), None),
    VfsCall("create", "Create an empty file.", PATH_ONLY, ("path",), None),
    VfsCall(
        "rename",
        "Rename a path within its mount.",
        {"src": PATH, "dst": PATH},
        ("src", "dst"),
        None,
    ),
    VfsCall(
        "symlink",
        "Make a symbolic link at a path.",
        {"path": PATH, "target": TEXT},
        ("path", "target"),
        None,
    ),
    VfsCall(
        "readlink",
        "Where a symbolic link points.",
        PATH_ONLY,
        ("path",),
        "target",
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
        "changed",
    ),
    VfsCall(
        "getxattr",
        "One extended attribute's value.",
        {"path": PATH, "name": TEXT, "nofollow": FLAG},
        ("path", "name"),
        "value_base64",
    ),
    VfsCall(
        "listxattr",
        "A path's extended attribute names.",
        {"path": PATH, "nofollow": FLAG},
        ("path",),
        "names",
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
        None,
    ),
    VfsCall(
        "removexattr",
        "Remove an extended attribute.",
        {"path": PATH, "name": TEXT, "nofollow": FLAG},
        ("path", "name"),
        None,
    ),
    VfsCall(
        "truncate",
        "Cut or extend a file to a length.",
        {"path": PATH, "length": INTEGER},
        ("path", "length"),
        None,
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
