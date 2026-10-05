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

from collections.abc import AsyncIterator, Callable
from typing import cast

from mirage.commands.builtin.generic.crossmount.types import OwnedScope
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS
from mirage.utils.path import respell_one


async def owned_scopes(
    path: PathSpec,
    dispatch: DispatchFn,
    ns: NamespaceView | None,
    admit: Callable[[PathSpec, FileStat], bool],
    walked: bool = False,
) -> AsyncIterator[OwnedScope]:
    """Yield maximal scopes with one owner, without reading file contents.

    Only directories containing a mount boundary are expanded. Dispatcher
    listings supply visible children and shadowed backend entries never
    become delegated operands. Iteration is lazy so a reducer can stop
    before another subtree is even listed.

    Args:
        path (PathSpec): One operand, retaining its typed spelling.
        dispatch (DispatchFn): Policy-checked metadata operations.
        ns (NamespaceView | None): Mount ownership facts.
        admit (Callable): The command's traversal filter for walked entries.
        walked (bool): Whether this entry was discovered below an operand.
    """
    if path.walk_error is not None or is_stdin(path):
        yield OwnedScope(path, walked)
        return
    try:
        info, _ = await dispatch("stat", path, nofollow=True)
        info = cast(FileStat, info)
        if walked and not admit(path, info):
            return
        boundaries = (
            ns.mounts.descendants(path.virtual) if ns and ns.mounts else []
        )
        if info.type != FileType.DIRECTORY or not boundaries:
            yield OwnedScope(path, walked, info)
            return
        entries, _ = await dispatch("readdir", path)
    except FS_ERRORS as exc:
        yield OwnedScope(path, walked, error=exc)
        return
    for entry in cast(list[str], entries):
        virtual = (
            path.virtual.rstrip("/")
            + "/"
            + entry.rstrip("/").rsplit("/", 1)[-1]
        )
        child = PathSpec(
            virtual=virtual,
            directory=virtual,
            vfs_path=virtual.strip("/"),
            raw_path=respell_one(virtual, path.virtual, path.raw_path),
        )
        async for scope in owned_scopes(child, dispatch, ns, admit, True):
            yield scope


def mount_starts(path: PathSpec, ns: NamespaceView | None) -> list[PathSpec]:
    """The operand, then each visible mount root below it, as start points.

    Each start is one mount's own part of the operand's tree: the
    operand's mount answers for everything but the mounts inside it, and
    every mount below answers from its root, spelled as the operand was
    typed. A hidden mount is never a start, though it still shadows the
    parent backend's keys.

    Args:
        path (PathSpec): One operand.
        ns (NamespaceView | None): Mount ownership facts.
    """
    if path.walk_error is not None or ns is None or ns.mounts is None:
        return [path]
    return [path] + [
        PathSpec(
            virtual=root,
            directory=root,
            vfs_path=root.strip("/"),
            raw_path=respell_one(root, path.virtual, path.raw_path),
        )
        for root in ns.mounts.visible_descendants(path.virtual)
    ]
