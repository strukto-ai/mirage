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

import functools

from mirage.context import path_allowed
from mirage.ops.config import NamespaceLinks
from mirage.ops.namespace_view import namespace_names
from mirage.ops.types import LinkView, MountView, NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat
from mirage.workspace.mount.namespace.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.mount.namespace.probe import (
    link_target_stat,
    path_exists,
    resolve_link,
)
from mirage.workspace.mount.registry import MountRegistry


def registry_child_mounts(
    registry: MountRegistry, links: NamespaceLinks | None, parent: str
) -> list[str]:
    """Child names the namespace owes ``parent``: mounts and links.

    The ``child_mounts`` fact offered to listing commands: the same
    names the door merges into its own readdir, derived from the same
    tables (mount names session-filtered), so the shell and the ops
    surface cannot disagree about what a directory holds.

    Args:
        registry (MountRegistry): registry holding the mount table.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): directory whose child segments to enumerate.
    """
    return namespace_names(
        [m.prefix for m in registry.mounts()], links, parent
    )


def link_view(
    namespace: Namespace | None, dispatch: DispatchFn | None
) -> LinkView | None:
    """Live symlink facts, or None without a namespace and dispatcher.

    Offered to every command as ``opts.ns.links``, whether or not it
    looks: a command opts in by reading the field, so there is no list
    of symlink-aware commands to keep in step here or anywhere else.

    Args:
        namespace (Namespace | None): addressing authority holding the
            link table, None outside a workspace.
        dispatch (DispatchFn | None): op dispatcher, which answers
            existence across mounts rather than within one backend.
    """
    if namespace is None or dispatch is None:
        return None
    return LinkView(
        stat_at=namespace.link_stat_at,
        children=namespace.link_stats_under,
        subtree=namespace.link_stats_below,
        resolve=functools.partial(resolve_link, namespace),
        exists=functools.partial(path_exists, dispatch),
        target_stat=functools.partial(link_target_stat, namespace, dispatch),
    )


def mount_roots_below(registry: MountRegistry, virtual: str) -> list[str]:
    """Mount roots strictly under a path, without the trailing slash.

    Every one, unfiltered: this is the list a caller avoids a boundary
    with, and a mount the session cannot see still shadows the parent
    backend's keys under its prefix.

    Args:
        registry (MountRegistry): registry holding the mount table.
        virtual (str): absolute virtual path to scan beneath.
    """
    return [
        m.prefix.rstrip("/") or "/"
        for m in registry.descendant_mounts(virtual)
    ]


def visible_mount_roots_below(
    registry: MountRegistry, virtual: str
) -> list[str]:
    """The mount roots under a path this session may be told about.

    The list a caller *names* a boundary from. The mount table is not
    session state, so nothing below filters it: a row in a tree, a
    member in an archive and a "different filesystem" warning are each
    produced above every backend, and each one hands back a name the
    session's hides were meant to withhold.

    Args:
        registry (MountRegistry): registry holding the mount table.
        virtual (str): absolute virtual path to scan beneath.
    """
    return [
        root
        for root in mount_roots_below(registry, virtual)
        if path_allowed(root)
    ]


def mount_root_of(registry: MountRegistry, virtual: str) -> str:
    """The mount prefix serving a virtual path, "/" when none does.

    A mount boundary is a filesystem boundary, which is what a caller
    walking up a tree needs in order to stop: `git` looks for a `.git`
    no further than the mount root, the way real git stops discovery at
    a filesystem boundary. A path under no mount answers "/" so the walk
    still terminates.

    Args:
        registry (MountRegistry): registry holding the mount table.
        virtual (str): absolute virtual path.
    """
    mount = registry.try_mount_for(virtual)
    return mount.prefix if mount is not None else "/"


def mount_max_du_entries(registry: MountRegistry, virtual: str) -> int | None:
    """The du walk budget of the mount serving a virtual path.

    Args:
        registry (MountRegistry): registry holding the mount table.
        virtual (str): absolute virtual path.
    """
    mount = registry.try_mount_for(virtual)
    return mount.vfs.max_du_entries if mount is not None else None


def mount_view(registry: MountRegistry) -> MountView:
    """The mount-boundary facts on offer to every command.

    Offered to every command as ``opts.ns.mounts``, the same way
    ``links`` is: a command opts in by reading the field, so there is
    no list of boundary-aware commands to keep in step.

    Args:
        registry (MountRegistry): registry holding the mount table.
    """
    return MountView(
        descendants=functools.partial(mount_roots_below, registry),
        visible_descendants=functools.partial(
            visible_mount_roots_below, registry
        ),
        is_root=registry.is_mount_root,
        root_of=functools.partial(mount_root_of, registry),
        max_du_entries=functools.partial(mount_max_du_entries, registry),
    )


def namespace_view_of(
    registry: MountRegistry,
    namespace: Namespace | None,
    dispatch: DispatchFn | None,
) -> NamespaceView:
    """The name plane's facts on offer, bundled as one view.

    Stamped on every invocation's ``CommandOpts`` as ``ns``, whether or
    not the handler looks; a command opts in by reading the field it
    wants, and one that grows a new name-plane need reads another field
    instead of threading a new keyword through ``execute_cmd``.

    Args:
        registry (MountRegistry): registry holding the mount table.
        namespace (Namespace | None): addressing authority holding the
            link table and attr overlay, None outside a workspace.
        dispatch (DispatchFn | None): op dispatcher, which answers
            existence across mounts rather than within one backend.
    """
    return NamespaceView(
        links=link_view(namespace, dispatch),
        mounts=mount_view(registry),
        stat_overlay=(
            functools.partial(namespace_stat_overlay, namespace)
            if namespace is not None
            else None
        ),
        child_mounts=functools.partial(
            registry_child_mounts, registry, namespace
        ),
        user=namespace.user if namespace is not None else None,
    )


def namespace_stat_overlay(
    namespace: Namespace, virtual: str, stat: FileStat
) -> FileStat:
    """Merge namespace attr overlays into one stat row (ls/stat rendering).

    Only what ``chmod``/``chown``/``chgrp``/``touch`` recorded: a path
    never chown'd keeps uid and gid None, and the owner-rendering
    commands fall back through ``Identity`` (the workspace user for the
    owner, the session's profile for the group), which is the one rule
    ``ls -l``, ``stat -c`` and ``find -printf`` share.

    Args:
        namespace (Namespace): addressing authority holding the overlay.
        virtual (str): absolute virtual path of the statted entry.
        stat (FileStat): backend stat result.
    """
    return merge_overlay_stat(namespace.meta_for(virtual), stat)
