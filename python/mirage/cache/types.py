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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum, auto
from typing import Literal, TypeAlias

from mirage.types import PathSpec

WriteKind = Literal["put", "copy", "delete"]


@dataclass(frozen=True, slots=True)
class WriteCondition:
    """The precondition one write carries.

    Empty when mirage holds no version of the object: the write goes out
    plain, there being nothing to compare.

    Args:
        if_match (str | None): the version the object must still have.
    """

    if_match: str | None = None


@dataclass(frozen=True, slots=True)
class WriteContext:
    """What a write on a ``write: conditional`` mount needs to know.

    Pushed by the mount's own doors (``MountEntry.call`` and its command
    scope), so a write always sees the context of the mount it lands on; an
    unconditional mount pushes None, which also clears an outer one.

    Args:
        vfs (str): the backend's name, for a refusal.
        conditions (frozenset[WriteKind]): the ops the backend can condition
            (put, copy, delete).
        read_version (Callable[[PathSpec], Awaitable[str | None]]): the
            version the mount last saw for a path (its cached copy's
            token), None when it saw none.
        read_versions (Callable[[list[PathSpec]], Awaitable[list[str |
            None]]]): ``read_version`` for many paths at once, in one
            store round trip.
        drop (Callable[[PathSpec], Awaitable[None]]): drops the mount's
            cached copy of a path, so the read a refusal asks for really
            fetches.
        keep (Callable[[PathSpec, str], Awaitable[None]]): keeps a version
            for a path without bytes, the one a refused write lost on.
    """

    vfs: str
    conditions: frozenset[WriteKind]
    read_version: Callable[[PathSpec], Awaitable[str | None]]
    read_versions: Callable[[list[PathSpec]], Awaitable[list[str | None]]]
    drop: Callable[[PathSpec], Awaitable[None]]
    keep: Callable[[PathSpec, str], Awaitable[None]]


# The version the mount saw for each of a walk's keys that it saw one for.
KnownVersions = Callable[[list[str]], Awaitable[dict[str, str]]]


class OwnRead(Enum):
    """An op's own read that found no file, as against one it never made."""

    ABSENT = auto()


# The version a key was measured on, or ABSENT for a key found gone.
Measured: TypeAlias = str | OwnRead
