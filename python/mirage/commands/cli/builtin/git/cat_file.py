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
import re
from collections.abc import AsyncIterator

from dulwich.objects import Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.repo import BaseRepo

from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    GitError,
    IncompatibleOptionsError,
    InvalidRevisionNameError,
    NoWorkspaceError,
    UsageError,
)
from mirage.commands.cli.builtin.git.revparse import resolve_object
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult

OBJECT_TYPES = ("blob", "tree", "commit", "tag")
# The query modes, each named by the switch that selects it.
QUERIES = ("t", "s", "e", "p")
BATCH_FORMAT = "%(objectname) %(objecttype) %(objectsize)"
FORMAT_ATOM = re.compile(r"%\(([^)]*)\)")
BATCH_ATOMS = frozenset({"objectname", "objecttype", "objectsize", "rest"})
HEX_ID = re.compile(r"[0-9a-f]{40}")


def named_object(repo: BaseRepo, name: str) -> ShaFile:
    """The object a name stands for, in cat-file's words when it stands
    for none.

    Args:
        repo (BaseRepo): the opened repository.
        name (str): the object name as typed.
    """
    try:
        return resolve_object(repo, name)
    except (AmbiguousArgumentError, InvalidRevisionNameError) as exc:
        raise GitError(f"Not a valid object name {name}") from exc


def peeled(repo: BaseRepo, obj: ShaFile, want: str) -> ShaFile | None:
    """An object peeled down to a type, git's read_object_with_reference:
    a tag to what it points at and a commit to its tree; None when the
    chain never reaches the type.

    Args:
        repo (BaseRepo): the opened repository.
        obj (ShaFile): the object the name stood for.
        want (str): the type asked for.
    """
    while obj.type_name.decode() != want:
        if isinstance(obj, Tag):
            obj = repo[obj.object[1]]
        elif isinstance(obj, Commit) and want == "tree":
            obj = repo[obj.tree]
        else:
            return None
    return obj


def pretty(obj: ShaFile) -> bytes:
    """``-p``: a tree as ls-tree lists it, any other object as stored.

    Args:
        obj (ShaFile): the object.
    """
    if not isinstance(obj, Tree):
        return obj.as_raw_string()
    kinds = {0o40000: b"tree", 0o160000: b"commit"}
    return b"".join(
        b"%06o %s %s\t%s\n" % (mode, kinds.get(mode, b"blob"), sha, name)
        for name, mode, sha in obj.iteritems()
    )


def _query(repo: BaseRepo, mode: str, name: str) -> tuple[bytes, int]:
    """One query mode's answer for one name, and its exit status.

    Args:
        repo (BaseRepo): the opened repository.
        mode (str): one of ``QUERIES``.
        name (str): the object name as typed.
    """
    if mode == "e" and HEX_ID.fullmatch(name):
        return b"", 0 if ObjectID(name.encode()) in repo.object_store else 1
    obj = named_object(repo, name)
    if mode == "t":
        return obj.type_name + b"\n", 0
    if mode == "s":
        return b"%d\n" % len(obj.as_raw_string()), 0
    if mode == "e":
        return b"", 0
    return pretty(obj), 0


def _batch_head(
    repo: BaseRepo, line: str, template: str
) -> tuple[bytes, ObjectID | None]:
    """One ``--batch``/``--batch-check`` format line and the id it names,
    ``<name> missing`` and None for a name that stands for nothing. With
    ``%(rest)`` in the format the name ends at the first blank and the rest
    of the line is ``%(rest)``.

    Args:
        repo (BaseRepo): the opened repository.
        line (str): one line of input.
        template (str): the format.
    """
    name, rest = line, ""
    if "%(rest)" in template:
        name, _, rest = line.partition(" ")
    try:
        obj = resolve_object(repo, name)
    except GitError:
        return f"{name} missing\n".encode(), None
    atoms = {
        "objectname": obj.id.decode(),
        "objecttype": obj.type_name.decode(),
        "objectsize": str(len(obj.as_raw_string())),
        "rest": rest,
    }
    head = FORMAT_ATOM.sub(lambda m: atoms[m.group(1)], template)
    return f"{head}\n".encode(), obj.id


async def _batch_lines(
    repo: BaseRepo, heads: list[tuple[bytes, ObjectID | None]], contents: bool
) -> AsyncIterator[bytes]:
    """The batch answers in order, each object's bytes read only when its
    turn comes, so a long ``--batch`` never holds every object at once.

    Args:
        repo (BaseRepo): the opened repository.
        heads (list[tuple[bytes, ObjectID | None]]): each line's format
            answer and the id it names.
        contents (bool): ``--batch``, which prints the bytes too.
    """
    for head, sha in heads:
        if not contents or sha is None:
            yield head
            continue
        obj = await asyncio.to_thread(repo.__getitem__, sha)
        yield head + obj.as_raw_string() + b"\n"


async def cat_file(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """``git cat-file``: an object's type, size, existence or content, for one
    name, a ``<type> <object>`` pair or each stdin line under ``--batch``.
    Pinned against git 2.50.1.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
    """
    fl = FlagView(inv.flags)
    doors = inv.doors or CLIDoors()
    texts = tuple(inv.texts)
    try:
        if doors.dispatch is None:
            raise NoWorkspaceError()
        check_switches(inv, texts)
        modes = fl.typed_order(*QUERIES)
        if len(modes) > 1:
            raise IncompatibleOptionsError(f"-{modes[1]}", f"-{modes[0]}")
        batch = fl.typed_order("batch", "batch_check")
        if batch:
            if texts:
                raise UsageError(
                    "",
                    "fatal: batch modes take no arguments\n\n"
                    + verb_usage(inv),
                )
            value = fl.raw(batch[-1])
            template = value if isinstance(value, str) else BATCH_FORMAT
            for found in FORMAT_ATOM.finditer(template):
                if found.group(1) not in BATCH_ATOMS:
                    raise GitError(f"bad cat-file format: {found.group(0)}")
            repo, _ = await opened(fl, doors)
            text = (await read_stdin_async(inv.stdin) or b"").decode(
                "utf-8", "replace"
            )
            lines = text.split("\n")
            if lines[-1] == "":
                lines.pop()
            heads = [
                await asyncio.to_thread(_batch_head, repo, line, template)
                for line in lines
            ]
            contents = batch[-1] == "batch"
            return _batch_lines(repo, heads, contents), IOResult()
        if not modes and not texts:
            raise UsageError("", verb_usage(inv))
        if modes:
            if not texts:
                raise UsageError(
                    "",
                    f"fatal: <object> required with '-{modes[0]}'\n\n"
                    + verb_usage(inv),
                )
            if len(texts) > 1:
                raise UsageError(
                    "", "fatal: too many arguments\n\n" + verb_usage(inv)
                )
            repo, _ = await opened(fl, doors)
            out, code = await asyncio.to_thread(
                _query, repo, modes[0], texts[0]
            )
            return out or None, IOResult(exit_code=code)
        if len(texts) != 2:
            raise UsageError(
                "",
                "fatal: only two arguments allowed in <type> <object> mode, "
                f"not {len(texts)}\n\n" + verb_usage(inv),
            )
        kind, name = texts
        if kind not in OBJECT_TYPES:
            raise GitError(f'invalid object type "{kind}"')
        repo, _ = await opened(fl, doors)
        obj = peeled(
            repo, await asyncio.to_thread(named_object, repo, name), kind
        )
        if obj is None:
            raise GitError(f"git cat-file {name}: bad file")
        return obj.as_raw_string(), IOResult()
    except GitError as exc:
        return fatal(exc)
