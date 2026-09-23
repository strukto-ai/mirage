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

import errno
import os
from collections.abc import Awaitable, Callable, Iterable
from typing import Protocol

from mirage.types import FileStat, FileType, PathSpec

Allowed = Callable[[str], bool]


class VisibleRemnant(OSError):
    """A remnant cascade met an entry the session can see.

    Raised by ``remove_remnants`` before the visible entry is touched:
    the caller's not-empty refusal is then simply true in the session's
    own view, so every arm answers this by re-raising that original
    refusal rather than deleting visible data.

    Args:
        virtual (str): absolute virtual path of the visible entry.
    """

    def __init__(self, virtual: str) -> None:
        super().__init__(errno.ENOTEMPTY, os.strerror(errno.ENOTEMPTY),
                         virtual)


class RemnantChannel(Protocol):
    """The four ops a remnant cascade speaks, on one plane's own
    protected channel.

    The channel carries every protection axis except visibility: a
    deletion must still answer for its path's mode and rules exactly as
    a first-class op would (the command plane binds its mode- and
    rule-guarded slots, the dispatchers route through their own op
    door), while the visibility filter stays off because the cascade
    exists to see and destroy what the session cannot. The cascade
    never sprinkles those checks itself; wiring a raw, unguarded
    channel here is the bug this contract exists to prevent.
    """

    def readdir(self, spec: PathSpec) -> Awaitable[list[str]]:
        ...

    def stat(self, spec: PathSpec) -> Awaitable[FileStat]:
        ...

    def unlink(self, spec: PathSpec) -> Awaitable[None]:
        ...

    def rmdir(self, spec: PathSpec) -> Awaitable[None]:
        ...


def entry_name(entry: str) -> str:
    """One listing entry's bare child name.

    Cold object-store listings mark a directory with a trailing slash,
    and some backends report whole paths rather than names; both
    normalize to the last component.

    Args:
        entry (str): one name from a backend readdir.
    """
    return entry.rstrip("/").rsplit("/", 1)[-1]


def visible_below(base: str, names: Iterable[str], allowed: Allowed) -> bool:
    """Whether any listed name is visible as a child of ``base``.

    The one emptiness predicate every remnant arm judges with, fed
    every name source its plane can enumerate (the backend listing,
    and on the ops plane the namespace's merged children too), so
    "visibly empty" cannot mean different things at different doors.

    Args:
        base (str): absolute virtual path of the directory.
        names (Iterable[str]): child names to test.
        allowed (Allowed): the session's visibility predicate.
    """
    root = base.rstrip("/")
    return any(allowed(f"{root}/{entry_name(n)}") for n in names)


def child_spec(spec: PathSpec, name: str) -> PathSpec:
    """The child PathSpec one cascade step descends to.

    Args:
        spec (PathSpec): the directory being walked.
        name (str): the child's bare name.
    """
    base = spec.virtual.rstrip("/")
    key = spec.vfs_path.rstrip("/")
    return PathSpec(virtual=f"{base}/{name}",
                    directory=spec.virtual,
                    vfs_path=f"{key}/{name}" if key else name)


async def remove_remnants(channel: RemnantChannel, allowed: Allowed,
                          spec: PathSpec) -> None:
    """Remove one directory and everything under it, children first,
    revalidating visibility at every step.

    The walk lists raw, but the moment any entry is visible the whole
    cascade aborts with ``VisibleRemnant`` before that entry is
    touched: between the caller's classification and each deletion
    another writer may have created something visible, and destroying
    it would turn an ostensibly empty rmdir into data loss. An entry
    that vanishes mid-walk is a completed removal (a prefix-store
    directory disappears with its last child), not an error. Every op
    goes through the channel, so the plane's other protections refuse
    exactly as they would a first-class op; the caller answers any
    cascade failure with its original refusal.

    Args:
        channel (RemnantChannel): the plane's guarded raw ops.
        allowed (Allowed): the session's visibility predicate.
        spec (PathSpec): the directory being removed.
    """
    try:
        entries = await channel.readdir(spec)
    except FileNotFoundError:
        return
    for entry in entries:
        name = entry_name(str(entry))
        child = child_spec(spec, name)
        if allowed(child.virtual):
            raise VisibleRemnant(child.virtual)
        try:
            row = await channel.stat(child)
        except FileNotFoundError:
            continue
        if isinstance(row, FileStat) and row.type is FileType.DIRECTORY:
            await remove_remnants(channel, allowed, child)
        else:
            try:
                await channel.unlink(child)
            except FileNotFoundError:
                continue
    try:
        await channel.rmdir(spec)
    except FileNotFoundError:
        return
