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

from mirage.shell.array import ShellArray
from mirage.types import FileStat

StatOverlay = Callable[[str, FileStat], FileStat]
# Stat one virtual path through the workspace rather than one backend, so
# a path under another mount still answers; None when nothing is there.
# What a traversal command asks about its own start point, which decides
# whether a walk is possible at all.
StatPath = Callable[[str], Awaitable["FileStat | None"]]
# readdir one virtual path through the workspace rather than one backend.
# What a walker whose output is a single document (tree) reads once it
# reaches a mount boundary, since the subtree below it lives in another
# resource that the walker's own accessor cannot open.
ReaddirPath = Callable[[str], Awaitable[list[str]]]
# The mount prefix serving a virtual path. A mount boundary is a
# filesystem boundary, which is where git stops looking for a repository
# (GIT_DISCOVERY_ACROSS_FILESYSTEM); crossing it would probe an
# unrelated backend.
MountRoot = Callable[[str], str]
# The mount roots strictly under a virtual path, in prefix order,
# without their trailing slash.
MountDescendants = Callable[[str], list[str]]
# Whether a virtual path IS a mount's root, rather than a directory the
# backend holds.
MountIsRoot = Callable[[str], bool]
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
# Child names the namespace owes a directory: nested mounts AND links,
# session-filtered. A nested mount is invisible to the parent mount's
# backend and a link is invisible to every backend, so a listing command
# is handed the names from above, the same names the ops surface merges
# into its own readdir.
ChildMounts = Callable[[str], list[str]]
# One session variable's value, None when unset. Sync: expansion-grade
# reads must stay dict lookups.
EnvGet = Callable[[str], "str | None"]
# A process-view copy of the whole environment.
EnvSnapshot = Callable[[], dict[str, str]]
# Write one variable through the session plane (readonly + pre_session).
# General over variable shapes: a string stores a scalar, a ShellArray
# stores a whole array, and the door keeps the two storages exclusive.
# Writers with richer mechanics (subscripts, appends, holes) compute the
# resulting value on a copy and hand it here, so a denial never leaves a
# half-applied write.
EnvSet = Callable[[str, str | ShellArray], Awaitable[None]]
# Drop one variable through the session plane; a missing name is quiet.
EnvUnset = Callable[[str], Awaitable[None]]
# Whether `readonly` has marked the name.
EnvIsReadonly = Callable[[str], bool]


@dataclass(frozen=True)
class SessionView:
    """The session-plane facts a command may consult, as one injected object.

    The ``LinkView`` pattern on the session plane: every field answers
    through the plane's own writers (``workspace/session/state``), so
    reads arrive exactly as the shell sees them and writes clear
    readonly plus the ``pre_session`` policy gate. The plain ``env``
    kwarg every command already receives stays the frozen process-view
    snapshot; this view is the live, gated handle for the command that
    needs one, and it is the whole capability: no field reaches the raw
    session behind it.

    A command opts in by naming a ``session_view`` parameter (``env``
    is taken by the snapshot), which is what makes the dispatcher hand
    it one.
    """

    get: EnvGet
    snapshot: EnvSnapshot
    set: EnvSet
    unset: EnvUnset
    is_readonly: EnvIsReadonly


@dataclass(frozen=True)
class MountView:
    """Where the mount boundaries are, as one injected object.

    A command runs bound to one backend, and that backend cannot see a
    mount nested inside its own tree: the child's keys live in another
    resource entirely, so the parent's ``readdir`` never lists it. A
    walker that must account for the whole subtree therefore has to be
    told, the same way ``LinkView`` tells it about symlinks.

    Traversal commands that render independent lines (find, grep -r)
    get this for free from the executor's fan-out, which reruns them per
    mount and concatenates the output. A command whose output is one
    binary object (tar, zip) cannot be merged that way, so it reads the
    boundaries here and says what it did with them. du is in between:
    its lines concatenate, but its per-directory totals are sums that
    already counted the parent backend's shadowed keys by the time any
    line filter runs, so it reads the boundaries here too and excludes a
    descendant's subtree while accounting.

    Delivered as the ``mounts`` field of ``NamespaceView``; a command
    opts in by naming an ``ns`` parameter.
    """

    # Mount roots strictly under a path (a walker: tar, zip).
    descendants: MountDescendants
    # Whether a path is a mount root itself.
    is_root: MountIsRoot
    # The mount serving a path, so a walker can tell "still mine" from
    # "another backend" before it tries to read something it cannot.
    root_of: MountRoot


@dataclass(frozen=True)
class LinkView:
    """The symlink facts a command may consult, as one injected object.

    Symlinks live in the workspace namespace and no backend can see
    them, so a command that must report them has to be handed the facts
    from above. Bundling them means a command that grows a new symlink
    need does not also grow a new keyword on ``execute_cmd``, every
    builder in the chain, and the generic; it reads another field off
    the view it already receives.

    Delivered as the ``links`` field of ``NamespaceView``; a command
    opts in by naming an ``ns`` parameter.
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


@dataclass(frozen=True)
class NamespaceView:
    """The name plane's facts a command may consult, as one injected object.

    Everything here answers from the workspace's addressing authority
    (the namespace node table plus the mount table), which no backend
    can see: symlinks, mount boundaries, the chmod/chown/touch attr
    overlay, and the child names the namespace owes a directory. One
    view per plane means a command that grows a new name-plane need
    adds a field read, not a new keyword threaded through
    ``execute_cmd``, every builder, and the generic.

    A command opts in by naming an ``ns`` parameter, which is what
    makes the dispatcher hand it one. Fields default to None so a unit
    test constructs only what it exercises; inside a workspace the
    dispatcher fills all four.
    """

    # The symlink facts; None when the namespace holds no links, which
    # is the fast path a walker checks before merging.
    links: LinkView | None = None
    # Where the mount boundaries are (tar, zip, du).
    mounts: MountView | None = None
    # The namespace attr merge for stat-rendering commands (ls).
    stat_overlay: StatOverlay | None = None
    # Child names the namespace owes a directory (mounts and links).
    child_mounts: ChildMounts | None = None
