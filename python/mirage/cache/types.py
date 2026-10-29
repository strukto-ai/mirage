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

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum, auto
from typing import TYPE_CHECKING, Literal, Protocol, TypeAlias

from mirage.io.types import ByteSource
from mirage.types import FileStat, PathSpec

if TYPE_CHECKING:
    from mirage.observe.record import OpRecord

WriteKind = Literal["put", "copy", "delete"]


class CacheInvalidator(Protocol):
    """The active cache operations a backend needs from its cache manager."""

    async def cached_sizes(
        self, paths: list[PathSpec]
    ) -> list[int | None]: ...

    async def is_cached(self, path: PathSpec) -> bool: ...

    def probed_stat(self, path: PathSpec) -> FileStat | None: ...


class AnyWrite(Enum):
    VALUE = auto()


class AbsentWrite(Enum):
    VALUE = auto()


@dataclass(frozen=True, slots=True)
class MatchWrite:
    version: str


WriteCondition: TypeAlias = AnyWrite | AbsentWrite | MatchWrite
ANY_WRITE = AnyWrite.VALUE
ABSENT_WRITE = AbsentWrite.VALUE
ConditionMode = Literal["absent", "match"]
ConditionSupport: TypeAlias = Mapping[WriteKind, frozenset[ConditionMode]]


@dataclass(frozen=True, slots=True)
class ReplaceRequest:
    path: PathSpec
    body: ByteSource
    condition: WriteCondition


RewriteWriteFn: TypeAlias = Callable[
    [ReplaceRequest], Awaitable[FileStat | None]
]


@dataclass(frozen=True, slots=True)
class LiveVersion:
    """A file's live tokens: the content token mirage compares, the native
    token the backend's condition takes.

    Args:
        content (str | None): the token mirage keeps for these bytes.
        native (str | None): the token the backend's condition takes.
    """

    content: str | None
    native: str | None


@dataclass(frozen=True, slots=True)
class WriteContext:
    """What a write on a ``write: conditional`` mount needs to know.

    Pushed by the mount's own entry points (``MountEntry.call`` and its command
    scope), so a write always sees the context of the mount it lands on; an
    unconditional mount pushes None, which also clears an outer one.

    Args:
        vfs (str): the backend's name, for a refusal.
        conditions (frozenset[WriteKind]): the ops the backend can condition
            (put, copy, delete).
        read_version (Callable[[PathSpec], Awaitable[str | None]]): the
            version the live session observed, or the mount's version
            without a session; None when no version is known.
        read_versions (Callable[[list[PathSpec]], Awaitable[list[str |
            None]]]): ``read_version`` for many paths at once.
        drop (Callable[[PathSpec], Awaitable[None]]): drops the mount's
            cached copy of a path, so the read a refusal asks for really
            fetches.
        keep (Callable[[PathSpec, str], Awaitable[None]]): keeps a version
            for a path without bytes, the one a refused write lost on.
        observe (Callable[[OpRecord], None] | None): record a caller's
            own read or mutation result.
        lose (Callable[[PathSpec, str | None], None] | None): retain a
            refused token, or clear it when the backend confirms absence.
    """

    vfs: str
    conditions: frozenset[WriteKind]
    read_version: Callable[[PathSpec], Awaitable[str | None]]
    read_versions: Callable[[list[PathSpec]], Awaitable[list[str | None]]]
    drop: Callable[[PathSpec], Awaitable[None]]
    keep: Callable[[PathSpec, str], Awaitable[None]]
    observe: Callable[["OpRecord"], None] | None = None
    lose: Callable[[PathSpec, str | None], None] | None = None


# The version the mount saw for each of a walk's keys that it saw one for.
KnownVersions = Callable[[list[str]], Awaitable[dict[str, str]]]


class OwnRead(Enum):
    """An op's own read that found no file or no usable version."""

    ABSENT = auto()
    UNKNOWN = auto()


# The version a key was measured on, or ABSENT for a key found gone.
Measured: TypeAlias = str | Literal[OwnRead.ABSENT]
