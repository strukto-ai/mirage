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

from mirage.types import FileStat

StatOverlay = Callable[[str, FileStat], FileStat]
# Stat one virtual path through the workspace rather than one backend, so
# a path under another mount still answers; None when nothing is there.
# What a traversal command asks about its own start point, which decides
# whether a walk is possible at all.
StatPath = Callable[[str], Awaitable["FileStat | None"]]
# The mount prefix serving a virtual path. A mount boundary is a
# filesystem boundary, which is where git stops looking for a repository
# (GIT_DISCOVERY_ACROSS_FILESYSTEM); crossing it would probe an
# unrelated backend.
MountRoot = Callable[[str], str]
# lstat for one path: the link's own stat, None when not a link.
LinkStat = Callable[[str], "FileStat | None"]
# Stat rows for the links directly under a directory, for listings.
LinkChildren = Callable[[str], list[FileStat]]
# Links at any depth under a directory, as (absolute virtual path, the
# link's own stat), for walkers.
LinkSubtree = Callable[[str], list[tuple[str, FileStat]]]
# Fully resolve a path through the link table (open(2) semantics).
LinkResolve = Callable[[str], str]
# Whether a virtual path names anything, resolved through the workspace
# rather than one backend, so a link across mounts answers correctly.
LinkExists = Callable[[str], Awaitable[bool]]
# The stat of what a link points at, None when it dangles or loops.
LinkTargetStat = Callable[[str], Awaitable["FileStat | None"]]


@dataclass(frozen=True)
class LinkView:
    """The symlink facts a command may consult, as one injected object.

    Symlinks live in the workspace namespace and no backend can see
    them, so a command that must report them has to be handed the facts
    from above. Bundling them means a command that grows a new symlink
    need does not also grow a new keyword on ``execute_cmd``, every
    builder in the chain, and the generic; it reads another field off
    the view it already receives.

    A command opts in by naming a ``links`` parameter, which is what
    makes the dispatcher hand it one.
    """

    # lstat one path (a link operand: `ls -l link`, `stat link`).
    stat_at: LinkStat
    # One directory level (a listing: `ls`, `ls -R` per group).
    children: LinkChildren
    # The whole subtree (a walker: `find`, `du`).
    subtree: LinkSubtree
    # Where a path really points, and whether anything is there. Both
    # are needed to tell a live link from a broken one.
    resolve: LinkResolve
    exists: LinkExists
    # What a link points at (`-L` reports the target's identity, not the
    # link's), resolved through the workspace so a link that crosses
    # mounts still answers.
    target_stat: LinkTargetStat
