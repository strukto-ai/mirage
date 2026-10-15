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

from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import INVALID, DetectFn, ScopeMatch
from mirage.errors.fs import eisdir, enoent
from mirage.types import FileStat, PathSpec

DeleteFn = Callable[[A, ScopeMatch, FileStat], Awaitable[None]]


def make_unlink(
    detect: DetectFn,
    *,
    deleters: Mapping[str, DeleteFn[A]],
) -> Callable[..., Awaitable[None]]:
    """Build a hierarchy unlink: classify, refuse, delete.

    A deleter owns only the backend delete call, handed the row the
    parent's listing names; classification and the directory refusal
    happen here, identically for every backend. The match rides along
    because a delete addressed inside a container needs the container's
    slots (gcal deletes an event from a calendar), while a
    globally-id-addressed backend just ignores it.

    Args:
        detect (DetectFn): the backend's scope classifier.
        deleters (Mapping[str, DeleteFn]): one deleter per leaf kind.
    """

    async def unlink(
        accessor: A, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        match = detect(path)
        deleter = deleters.get(match.kind)
        if deleter is None:
            if match.kind != INVALID and (
                match.scope is None or not match.scope.leaf
            ):
                raise eisdir(path.virtual)
            raise enoent(path)
        if entry is None:
            raise enoent(path)
        await deleter(accessor, match, entry)

    return unlink
