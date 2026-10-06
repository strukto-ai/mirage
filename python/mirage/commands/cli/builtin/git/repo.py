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
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.object_store import PackCapableObjectStore
from dulwich.refs import RefsContainer
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.objects import load_object_store
from mirage.commands.cli.builtin.git.refs import load_refs
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import git_bool
from mirage.runtime.types import DispatchFn
from mirage.utils.path import join_spec


class Repo(BaseRepo):
    """A repository opened from a mount: dulwich's ``BaseRepo`` and the
    planes a resolution reaching past the object store needs.

    The working tree and the index are read through the dispatcher, on
    the loop serving the mount, from the worker thread a resolution runs
    on.

    Args:
        store (PackCapableObjectStore): the object database.
        refs (RefsContainer): every ref, as load_refs reads them.
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        loop (asyncio.AbstractEventLoop): the loop serving the mount.
        ambiguous (list[str] | None): where resolving a name two refs
            answer to puts git's ``refname is ambiguous`` warning, for
            the verb to print ahead of its own stderr; None when
            ``core.warnAmbiguousRefs`` is off or nothing collects them.
    """

    def __init__(
        self,
        store: PackCapableObjectStore,
        refs: RefsContainer,
        dispatch: DispatchFn,
        location: RepoLocation,
        loop: asyncio.AbstractEventLoop,
        ambiguous: list[str] | None,
    ) -> None:
        super().__init__(store, refs)
        self.dispatch = dispatch
        self.location = location
        self.loop = loop
        self.ambiguous = ambiguous


async def open_repo(
    dispatch: DispatchFn,
    location: RepoLocation,
    ambiguous: list[str] | None = None,
) -> Repo:
    """Open a repository living in a mount as a dulwich repository.

    This is the async-to-sync boundary the whole design turns on. Every
    byte is fetched here, through the dispatcher; what comes back is an
    ordinary `BaseRepo`, so dulwich's own algorithms (the history
    walker, tree diff, three-way merge) run against a mount without ever
    learning that one exists. `BaseRepo` is the pluggable half of
    dulwich: `Repo` is the one that insists on a real filesystem.

    No working tree and no index are attached. Those are the parts
    dulwich hardwires to disk, and the parts mirage has to own.

    Objects come from the common directory and refs from both: a linked
    worktree shares the object database and the branches of the
    repository it was cut from, and owns only HEAD and whatever refs
    are per-checkout.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        ambiguous (list[str] | None): where ambiguity warnings go, None
            for nowhere.
    """
    store = await load_object_store(dispatch, location.commondir)
    refs = await load_refs(dispatch, location.gitdir, location.commondir)
    return Repo(
        store, refs, dispatch, location, asyncio.get_running_loop(), ambiguous
    )


async def config_values(
    dispatch: DispatchFn, location: RepoLocation, section: bytes, name: bytes
) -> list[bytes]:
    """Every value a variable takes in the repository's config, in order.

    Only the repository's own config is reachable from a mount, and a
    linked worktree's config is its repository's.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        section (bytes): the section, e.g. ``b"core"``.
        name (bytes): the variable, e.g. ``b"worktree"``.
    """
    data = await read_optional(
        dispatch, join_spec(location.commondir, "config")
    )
    if data is None:
        return []
    config = ConfigFile.from_file(BytesIO(data))
    try:
        return list(config.get_multivar((section,), name))
    except KeyError:
        return []


async def config_bool(
    dispatch: DispatchFn,
    location: RepoLocation,
    section: bytes,
    name: bytes,
    default: bool,
) -> bool:
    """A boolean from the repository's config, read the way git reads one.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
        section (bytes): the section, e.g. ``b"core"``.
        name (bytes): the variable, e.g. ``b"quotepath"``.
        default (bool): the answer when the variable is unset.

    Raises:
        BadConfigValueError: a value git cannot read as a boolean.
    """
    values = await config_values(dispatch, location, section, name)
    key = b".".join((section, name)).decode(errors="replace").lower()
    return git_bool(values, key, default)
