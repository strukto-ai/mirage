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

from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.errors import NoWorkspaceError
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import start_point
from mirage.commands.cli.types import CLIDoors
from mirage.commands.spec.types import FlagView


async def opened(fl: FlagView,
                 doors: CLIDoors) -> tuple[BaseRepo, RepoLocation]:
    """Discover and open the repository a verb was invoked against.

    Every verb starts the same way: honor ``-C``, walk up to the mount
    root looking for a ``.git``, then pull the object database across
    the dispatcher. Kept in one place so a new verb inherits the
    discovery rules rather than restating them, and so the refusal a
    verb owes outside a workspace is written once.

    The mount root comes from the name plane rather than a door of its
    own: ``ns.mounts.root_of`` is the same fact the command tier reads,
    and a second field holding the same callable is a second thing to
    keep in step.

    Args:
        fl (FlagView): the leaf's flag bag, read for ``-C``.
        doors (CLIDoors): the invocation's doors, one per state plane.

    Raises:
        NoWorkspaceError: a plane this verb needs is not wired.
    """
    dispatch = doors.dispatch
    stat_path = doors.stat_path
    mounts = doors.ns.mounts if doors.ns is not None else None
    if stat_path is None or mounts is None or dispatch is None:
        raise NoWorkspaceError()
    location = await discover(dispatch, stat_path, mounts.root_of,
                              start_point(fl))
    return await open_repo(dispatch, location), location
