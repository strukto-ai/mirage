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

from mirage.commands.config import ExecContext
from mirage.commands.errors import CommandTimeoutError, UsageError
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.commands.spec.usage import read_fail_exit
from mirage.context import path_allowed
from mirage.io import IOResult
from mirage.io.stream import materialize, wrap_cachable_streams
from mirage.io.types import ByteSource
from mirage.ops.config import NamespaceLinks
from mirage.ops.namespace_view import namespace_names
from mirage.ops.types import LinkView, MountView, NamespaceView
from mirage.runtime.base import Runtime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.table import VFSRuntime
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec, ResourceName
from mirage.utils.errors import format_fs_error
from mirage.workspace.executor.builtins.links import (link_target_stat,
                                                      path_exists,
                                                      path_readdir, path_stat)
from mirage.workspace.executor.command.flags import parse_flags
from mirage.workspace.mount import (MountCommandUnsupported, MountEntry,
                                    MountRegistry)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.session import Session, env_snapshot, session_view
from mirage.workspace.types import ExecutionNode


async def exec_node(cmd_str: str, io: IOResult,
                    paths: list[PathSpec]) -> ExecutionNode:
    """Build the recorded execution node, materializing any streamed stderr.

    Args:
        cmd_str (str): Original command text for the record.
        io (IOResult): Command result whose stderr/exit_code the node carries.
        paths (list[PathSpec]): Classified path operands, carried so the
            lazy-stream drain can respell filesystem errors as typed.
    """
    # The node is a recorded artifact (compared by value, serialized via a
    # sync to_dict, sometimes read twice), so the live lazy io.stderr is
    # materialized to concrete bytes here. On the cross-mount path it is bytes.
    return ExecutionNode(command=cmd_str,
                         stderr=await materialize(io.stderr),
                         exit_code=io.exit_code,
                         paths=paths)


def admission_denial(cmd_name: str) -> IOResult:
    """The 126 result for a command no runtime accepted.

    Args:
        cmd_name (str): the refused command.
    """
    msg = f"{cmd_name}: no runtime accepted this line\n"
    return IOResult(exit_code=126, stderr=msg.encode())


def line_runtime_for(
        cmd_name: str, registry: MountRegistry, routing: RouteDecision | None
) -> tuple[Runtime | None, IOResult | None]:
    """Resolve a command against the line's routing decision.

    With no decision, the workspace's static bindings apply. With one,
    the command's runtime is looked up in the decision: its binding,
    or the decision's fallback when no entry captures it. A resolved
    VFSRuntime means the executor serves the command itself (the vfs
    runtime has no interpreter door); None means no runtime accepted
    it: exit 126, like a shell refusing to exec.

    Args:
        cmd_name (str): the command being dispatched.
        registry (MountRegistry): registry holding static bindings and
            the world's vfs runtime.
        routing (RouteDecision | None): the typed line's decision.
    """
    if routing is None:
        vfs = registry.vfs_runtime
        restricted = isinstance(vfs, VFSRuntime) and vfs.restricted
        runtime = registry.runtime_bindings.get(cmd_name)
        if runtime is vfs and vfs is not None:
            return None, None
        if runtime is None and restricted:
            return None, admission_denial(cmd_name)
        return runtime, None
    runtime = routing.bindings.get(cmd_name, routing.fallback)
    if runtime is None:
        return None, admission_denial(cmd_name)
    if isinstance(runtime, VFSRuntime):
        return None, None
    return runtime, None


def find_start_points(argv: list[str | PathSpec], expr_tokens: list[str],
                      spec: CommandSpec | None, cwd: str) -> list[PathSpec]:
    """find's start points: the path operands typed before its expression.

    The expression tail is the parser's, so a word inside it (an
    ``-exec`` command word, a ``-newer`` reference) is never a start
    point even when the rest slot's PATH kind would have read it as one.
    Only the head is parsed against the spec, so what it yields as path
    operands is exactly the start points.

    Args:
        argv (list[str | PathSpec]): the classified words after `find`.
        expr_tokens (list[str]): the expression tail, as `find_expr_tail`
            cut it off the same words.
        spec (CommandSpec | None): find's spec on the mount.
        cwd (str): the session's working directory.
    """
    head = argv[:len(argv) - len(expr_tokens)]
    return parse_flags(head, spec, "find", cwd).paths


def scalar_find_flags(
        flag_kwargs: dict[str, FlagValue]) -> dict[str, FlagValue]:
    # `multiple=True` on find value-flags makes parse_to_kwargs emit
    # lists; bespoke backend wrappers read these as scalars. Migrated
    # backends read the expression from `texts` and ignore flag_kwargs.
    return {
        k: (v[-1] if isinstance(v, list) and v else v)
        for k, v in flag_kwargs.items()
    }


def registry_child_mounts(registry: MountRegistry,
                          links: NamespaceLinks | None,
                          parent: str) -> list[str]:
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
    return namespace_names([m.prefix for m in registry.mounts()], links,
                           parent)


def link_view(namespace: Namespace | None,
              dispatch: DispatchFn | None) -> LinkView | None:
    """The symlink facts on offer, or None when there are no links.

    Offered to every command as ``opts.ns.links``, whether or not it
    looks: a command opts in by reading the field, so there is no list
    of symlink-aware commands to keep in step here or anywhere else.

    Args:
        namespace (Namespace | None): addressing authority holding the
            link table, None outside a workspace.
        dispatch (DispatchFn | None): op dispatcher, which answers
            existence across mounts rather than within one backend.
    """
    if namespace is None or dispatch is None or not namespace.has_links():
        return None
    return LinkView(stat_at=namespace.link_stat_at,
                    children=namespace.link_stats_under,
                    subtree=namespace.link_stats_below,
                    resolve=namespace.follow,
                    exists=functools.partial(path_exists, dispatch),
                    target_stat=functools.partial(link_target_stat, namespace,
                                                  dispatch))


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


def visible_mount_roots_below(registry: MountRegistry,
                              virtual: str) -> list[str]:
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
        root for root in mount_roots_below(registry, virtual)
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


def mount_view(registry: MountRegistry) -> MountView:
    """The mount-boundary facts on offer to every command.

    Offered to every command as ``opts.ns.mounts``, the same way
    ``links`` is: a command opts in by reading the field, so there is
    no list of boundary-aware commands to keep in step.

    Args:
        registry (MountRegistry): registry holding the mount table.
    """
    return MountView(descendants=functools.partial(mount_roots_below,
                                                   registry),
                     visible_descendants=functools.partial(
                         visible_mount_roots_below, registry),
                     is_root=registry.is_mount_root,
                     root_of=functools.partial(mount_root_of, registry))


def namespace_view_of(registry: MountRegistry, namespace: Namespace | None,
                      dispatch: DispatchFn | None) -> NamespaceView:
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
        stat_overlay=(functools.partial(namespace_stat_overlay, namespace)
                      if namespace is not None else None),
        child_mounts=functools.partial(registry_child_mounts, registry,
                                       namespace),
        user=namespace.user if namespace is not None else None)


async def drop_service_caches(registry: MountRegistry,
                              serves: tuple[ResourceName, ...]) -> None:
    """Drop cached listings and bodies for the mounts a CLI's service backs.

    An account CLI mutates its service by id, so no vfs path can be
    derived from the call and per-path invalidation has nothing to aim
    at: after `gws sheets spreadsheets create` the new file has no cache
    entry to expire, which is exactly the case that matters. What is
    known is the service, so the mounts it backs drop their caches and
    the next read refetches.

    Both caches go, because the two hide different writes. A stale
    listing hides a create or a delete; a stale body hides an edit, and
    these resources cache reads, so a `cat` after `gws docs documents
    batchUpdate` would otherwise keep serving the pre-edit content
    without ever reaching Google.

    Scoped by the spec's declared ``serves`` rather than a blanket
    reset, so a Slack or S3 mount alongside keeps its cache.

    Args:
        registry (MountRegistry): registry holding the mount table.
        serves (tuple[ResourceName, ...]): resources the CLI's service
            backs; empty drops nothing.
    """
    if not serves:
        return
    wanted = set(serves)
    for mount in registry.mounts():
        if mount.resource.name not in wanted:
            continue
        # Invalidate rather than clear: a cleared index reads exactly like
        # one that was never filled, so a backend whose index *is* its
        # listing (github seeds the whole tree once) cannot tell the drop
        # from an empty repository and reports the mount as gone. Expiring
        # keeps that distinction and the next read refetches.
        await mount.index.invalidate()
        if mount.cache_manager is not None:
            await mount.cache_manager.drop_prefix()


def namespace_stat_overlay(namespace: Namespace, virtual: str,
                           stat: FileStat) -> FileStat:
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


async def run_on_mount(
    registry: MountRegistry,
    session: Session,
    dispatch: DispatchFn,
    namespace: Namespace | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    stdin: ByteSource | None = None,
    resolve_hint: PathSpec | None = None,
    mount: MountEntry | None = None,
    routing_decision: RouteDecision | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run one already-parsed command on the mount that owns its paths.

    The shared single-mount execution tail: mount resolution, session
    mode checks, ``execute_cmd``, filesystem-error formatting, ls/find
    post-processing,
    and read/write key prefixing. ``handle_command`` uses it for the normal
    path, and passes it (bound) to the cross-mount runners so each operand
    executes natively on its owning mount.

    Args:
        registry (MountRegistry): Mount registry.
        session (Session): Session providing cwd/env/session_id.
        dispatch (Callable): Workspace operation dispatcher.
        namespace (Namespace | None): Addressing authority for ls symlinks.
        cmd_name (str): Command name.
        paths (list[PathSpec]): Positional path operands (may hold globs;
            the mount wrapper expands them natively).
        texts (list[str]): Positional text operands.
        flag_kwargs (dict): Parsed flags forwarded to the mount command.
        stdin (ByteSource | None): Standard input for the command.
        resolve_hint (PathSpec | None): Mount-resolution path when ``paths``
            is empty (a stream command running in stdin mode).
        mount: Pre-resolved mount; skips resolution and session mode
            checks, which the caller already performed.
    """
    if mount is None:
        resolve_paths = paths or ([resolve_hint] if resolve_hint else [])
        try:
            mount = await registry.resolve_mount(cmd_name, resolve_paths,
                                                 session.cwd)
        except MountCommandUnsupported as exc:
            return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
        if mount is None:
            return None, IOResult(
                exit_code=127,
                stderr=f"{cmd_name}: command not found".encode())
    if cmd_name == "find":
        flag_kwargs = scalar_find_flags(flag_kwargs)

    # The facts the backend cannot supply, offered to every command and
    # delivered only to the handlers that name them as a parameter.
    # ls/stat render stat rows from the backend's own stat, which never
    # sees namespace attr overlays (chmod/chown/touch on overlay backends)
    # or the default owner; the merge makes ls -l and stat -c agree.
    # cp/mv -u freshness checks compare the same merged mtimes, and
    # find -mtime filters on them (touch results, observed writes).
    # Symlinks are namespace state no backend readdir or stat can see.
    # A traversal command's start point is statted through the dispatcher
    # so a start point under another mount answers (`find -L` follows a
    # link across mounts before the command ever runs).
    ns = namespace_view_of(registry, namespace, dispatch)
    stat_path = (functools.partial(path_stat, dispatch)
                 if dispatch is not None else None)
    readdir_path = (functools.partial(path_readdir, dispatch)
                    if dispatch is not None else None)

    line_runtime, denial = line_runtime_for(cmd_name, registry,
                                            routing_decision)
    if denial is not None:
        return None, denial

    try:
        stdout, io = await mount.execute_cmd(
            cmd_name,
            paths,
            texts,
            flag_kwargs,
            ExecContext(
                stdin=stdin,
                cwd=session.cwd,
                dispatch=dispatch,
                session_id=session.session_id,
                env=env_snapshot(session),
                session_view=session_view(session, registry.policies),
                exec_allowed=registry.is_exec_allowed(),
                exec_path_allowed=registry.exec_allowed_at,
                runtime=line_runtime,
                runtime_unavailable=registry.runtime_unavailable.get(cmd_name),
                ns=ns,
                stat_path=stat_path,
                readdir_path=readdir_path,
            ),
        )
    except UsageError as exc:
        # Command-owned usage errors (extra operands, missing patterns)
        # become this command's IOResult so the rest of the line keeps
        # running, like a real shell (#452).
        return None, IOResult(exit_code=exc.exit_code,
                              stderr=f"{exc}\n".encode())
    except CommandTimeoutError:
        # A limit timeout is answered by the workspace-level handler
        # (exit 124), not here.
        raise
    except Exception as exc:
        # Every other thrown command error (a backend RuntimeError, a
        # ValueError, or a filesystem OSError) becomes this command's
        # IOResult, prefixed with the command name like GNU (prog: message)
        # and the TypeScript executor.
        return None, IOResult(exit_code=read_fail_exit(cmd_name, exc),
                              stderr=format_fs_error(cmd_name, exc, paths))

    prefix = mount.prefix.rstrip("/")
    if prefix:
        io.reads = {prefix + k: v for k, v in io.reads.items()}
        io.writes = {prefix + k: v for k, v in io.writes.items()}
        io.cache = [prefix + p for p in io.cache]
    return wrap_cachable_streams(stdout, io)
