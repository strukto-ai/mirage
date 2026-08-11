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

from typing import Any, Callable

from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.objects import load_object_store
from mirage.commands.cli.builtin.git.refs import load_refs
from mirage.commands.cli.builtin.git.types import RepoLocation


async def open_repo(dispatch: Callable[..., Any],
                    location: RepoLocation) -> BaseRepo:
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
        dispatch (Callable): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
    """
    store = await load_object_store(dispatch, location.commondir)
    refs = await load_refs(dispatch, location.gitdir, location.commondir)
    return BaseRepo(store, refs)
