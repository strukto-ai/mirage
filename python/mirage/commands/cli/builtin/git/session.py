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
from mirage.commands.spec.types import FlagView
from mirage.ops.types import MountRoot, StatPath
from mirage.runtime.types import DispatchFn


async def opened(
    fl: FlagView,
    stat_path: StatPath | None,
    mount_root: MountRoot | None,
    dispatch: DispatchFn | None,
) -> tuple[BaseRepo, RepoLocation]:
    """Discover and open the repository a verb was invoked against.

    Every verb starts the same way: honor ``-C``, walk up to the mount
    root looking for a ``.git``, then pull the object database across
    the dispatcher. Kept in one place so a new verb inherits the
    discovery rules rather than restating them.

    Args:
        fl (FlagView): the leaf's flag bag, read for ``-C``.
        stat_path (StatPath | None): dispatcher-backed stat, both
            channels.
        mount_root (MountRoot | None): the mount prefix serving a path.
        dispatch (Callable | None): workspace op dispatcher.
    """
    if stat_path is None or mount_root is None or dispatch is None:
        raise NoWorkspaceError()
    location = await discover(dispatch, stat_path, mount_root, start_point(fl))
    return await open_repo(dispatch, location), location
