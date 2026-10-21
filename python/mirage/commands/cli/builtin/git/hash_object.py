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

import asyncio
import hashlib
import re

from dulwich.objects import Blob, Commit, ShaFile, Tag, Tree

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.cli.builtin.git.constants import OBJECT_TYPES
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    ObjectWriteReadOnlyError,
)
from mirage.commands.cli.builtin.git.io import read_file
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    require_vfs,
    start_point,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.workspace.files import Files

OBJECT_CLASSES: dict[str, type[ShaFile]] = {
    "blob": Blob,
    "tree": Tree,
    "commit": Commit,
    "tag": Tag,
}
HEX_ID = re.compile(rb"[0-9a-f]{40}")
# fsck's ident: a name, an email in angle brackets, a time and a zone.
IDENT = re.compile(rb"[^<>\n]*<[^<>\n]*> [0-9]+ [+-][0-9]{4}")
TREE_ENTRY = re.compile(rb"([0-7]+) ([^\0/]+)\0", re.DOTALL)


def well_formed(kind: str, data: bytes) -> bool:
    """Whether content is the object it claims to be, the checks git's
    fsck makes before hash-object will hash a tree, commit or tag: a
    tree's entries parse and sort, a commit names its tree, parents,
    author and committer, a tag its object, type and name.

    Args:
        kind (str): one of ``OBJECT_TYPES``.
        data (bytes): the content.
    """
    if kind == "tree":
        at = 0
        prior: bytes | None = None
        while at < len(data):
            entry = TREE_ENTRY.match(data, at)
            if entry is None or entry.end() + 20 > len(data):
                return False
            key = entry.group(2)
            if entry.group(1) in (b"40000", b"040000"):
                key += b"/"
            if prior is not None and not prior < key:
                return False
            prior = key
            at = entry.end() + 20
        return True
    head = data.split(b"\n\n", 1)[0].split(b"\n")
    if kind == "commit":
        if not head or not head[0].startswith(b"tree "):
            return False
        if not HEX_ID.fullmatch(head[0][5:]):
            return False
        rest = head[1:]
        while rest and rest[0].startswith(b"parent "):
            if not HEX_ID.fullmatch(rest[0][7:]):
                return False
            rest = rest[1:]
        return (
            len(rest) >= 2
            and rest[0].startswith(b"author ")
            and IDENT.fullmatch(rest[0][7:]) is not None
            and rest[1].startswith(b"committer ")
            and IDENT.fullmatch(rest[1][10:]) is not None
        )
    if kind == "tag":
        return (
            len(head) >= 3
            and head[0].startswith(b"object ")
            and HEX_ID.fullmatch(head[0][7:]) is not None
            and head[1][5:].decode("latin-1") in OBJECT_TYPES
            and head[1].startswith(b"type ")
            and head[2].startswith(b"tag ")
            and len(head[2]) > 4
        )
    return True


def object_id(kind: str, data: bytes) -> bytes:
    """The id git stores content under: the sha1 of its header and bytes.

    Args:
        kind (str): one of ``OBJECT_TYPES``.
        data (bytes): the content.
    """
    return (
        hashlib.sha1(b"%s %d\0" % (kind.encode(), len(data)) + data)
        .hexdigest()
        .encode()
    )


async def _content(vfs: Files, base: PathSpec, name: str) -> bytes:
    """A file's bytes, in git's words when it cannot be read.

    Args:
        vfs (Files): the session's files.
        base (PathSpec): the directory a relative name starts from.
        name (str): the path as typed.
    """
    try:
        return await read_file(vfs, PathSpec.from_str_path(name, cwd=base))
    except IsADirectoryError as exc:
        raise GitError(f"Unable to hash {name}") from exc
    except (FileNotFoundError, NotADirectoryError, PermissionError) as exc:
        reason = fs_strerror(exc) or "No such file or directory"
        raise GitError(
            f"could not open '{name}' for reading: {reason}"
        ) from exc


async def hash_object(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """``git hash-object``: the id content would be stored under, read from
    each FILE, ``--stdin`` or ``--stdin-paths``. Another type than blob is
    checked first unless ``--literally`` (without git's fsck detail lines), and
    ``-w`` writes the object. Pinned against git 2.50.1.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    vfs = require_vfs(ctx)
    check_switches(ctx, texts)
    kind = fl.as_str("t", "blob")
    if kind not in OBJECT_TYPES:
        raise GitError(f'invalid object type "{kind}"')
    literally = fl.as_bool("literally")
    base = start_point(fl)
    contents: list[bytes] = []
    if fl.as_bool("stdin"):
        contents.append(await read_stdin_async(ctx.stdin) or b"")
    names = list(texts)
    if fl.as_bool("stdin_paths"):
        listed = (await read_stdin_async(ctx.stdin) or b"").decode(
            "utf-8", "replace"
        )
        names += [line for line in listed.split("\n") if line]
    for name in names:
        contents.append(await _content(vfs, base, name))
    if not literally and not all(well_formed(kind, d) for d in contents):
        raise GitError("refusing to create malformed object")
    if fl.as_bool("w") and contents:
        repo, _ = await opened(ctx, fl)
        cls = OBJECT_CLASSES[kind]
        for data in contents:
            obj = cls.from_raw_string(cls.type_num, data)
            await asyncio.to_thread(repo.object_store.add_object, obj)
    out = b"".join(object_id(kind, data) + b"\n" for data in contents)
    return out or None, IOResult()


def hash_object_read_only(
    texts: list[str], ctx: Context, location: RepoLocation | None
) -> GitError:
    """hash-object's refusal by a read-only mount: the first object it
    could not add, named as typed, ``(null)`` for stdin's.

    Args:
        texts (list[str]): the line's operands.
        ctx (Context): the line's context.
        location (RepoLocation | None): the repository it opened.
    """
    fl = FlagView(ctx.flags)
    stdin = fl.as_bool("stdin") or not texts
    return ObjectWriteReadOnlyError("(null)" if stdin else texts[0])
