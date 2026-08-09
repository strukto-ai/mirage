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
from typing import Any

from mirage.commands.builtin.generic.ls import LS_FAILURE
from mirage.commands.builtin.utils.limit import CommandTimeoutError
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue
from mirage.io import IOResult
from mirage.io.stream import materialize, wrap_cachable_streams
from mirage.io.types import ByteSource
from mirage.ops.types import LinkView, MountView
from mirage.runtime.base import Runtime
from mirage.runtime.policy import PolicyDecision
from mirage.runtime.table import VFSRuntime
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec, ResourceName
from mirage.utils.errors import format_fs_error
from mirage.workspace.executor.builtins.links import (link_target_stat,
                                                      path_exists, path_stat)
from mirage.workspace.executor.find_action_dispatch import _apply_find_actions
from mirage.workspace.mount import (MountCommandUnsupported, MountEntry,
                                    MountRegistry)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.session import Session, assert_mount_allowed
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
        cmd_name: str, registry: MountRegistry, routing: PolicyDecision | None
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
        routing (PolicyDecision | None): the typed line's decision.
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


def scalar_find_flags(
        flag_kwargs: dict[str, FlagValue]) -> dict[str, FlagValue]:
    # `multiple=True` on find value-flags makes parse_to_kwargs emit
    # lists; bespoke backend wrappers read these as scalars. Migrated
    # backends read the expression from `texts` and ignore flag_kwargs.
    return {
        k: (v[-1] if isinstance(v, list) and v else v)
        for k, v in flag_kwargs.items()
    }


def link_view(namespace: Namespace | None,
              dispatch: DispatchFn | None) -> LinkView | None:
    """The symlink facts on offer, or None when there are no links.

    Which commands actually receive this is decided at dispatch, by
    whether the handler names a ``links`` parameter, so there is no list
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

    Args:
        registry (MountRegistry): registry holding the mount table.
        virtual (str): absolute virtual path to scan beneath.
    """
    return [
        m.prefix.rstrip("/") or "/"
        for m in registry.descendant_mounts(virtual)
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
    try:
        return registry.mount_for(virtual).prefix
    except ValueError:
        return "/"


def mount_view(registry: MountRegistry) -> MountView:
    """The mount-boundary facts on offer to every command.

    Which commands receive it is decided at dispatch by whether the
    handler names a ``mounts`` parameter, the same opt-in ``links``
    uses, so there is no list of boundary-aware commands to keep in
    step.

    Args:
        registry (MountRegistry): registry holding the mount table.
    """
    return MountView(descendants=functools.partial(mount_roots_below,
                                                   registry),
                     is_root=registry.is_mount_root,
                     root_of=functools.partial(mount_root_of, registry))


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
        await mount.resource.index.clear()
        if mount.cache_manager is not None:
            await mount.cache_manager.drop_prefix()


def namespace_stat_overlay(namespace: Namespace, virtual: str,
                           stat: FileStat) -> FileStat:
    """Merge namespace attr overlays into one stat row (ls/stat rendering).

    A path never chown'd defaults its owner to the workspace user (the
    launch agent, what ``whoami`` reports), so ``ls -l`` and ``stat -c``
    agree on ownership. An unclaimed workspace leaves uid/gid None and the
    formatters fall back to the neutral ``user`` placeholder.

    Args:
        namespace (Namespace): addressing authority holding the overlay.
        virtual (str): absolute virtual path of the statted entry.
        stat (FileStat): backend stat result.
    """
    merged = merge_overlay_stat(namespace.meta_for(virtual), stat)
    user = namespace.user
    if user is None:
        return merged
    update: dict[str, Any] = {}
    if merged.uid is None:
        update["uid"] = user
    if merged.gid is None:
        update["gid"] = user
    return merged.model_copy(update=update) if update else merged


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
    routing_decision: PolicyDecision | None = None,
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
        try:
            assert_mount_allowed(mount.prefix)
            for ps in paths:
                target = registry.mount_for(ps.virtual)
                assert_mount_allowed(target.prefix)
        except PermissionError as exc:
            return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())

    if cmd_name == "find":
        flag_kwargs = scalar_find_flags(flag_kwargs)

    # Three facts the backend cannot supply, offered to every command and
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
    stat_overlay = (functools.partial(namespace_stat_overlay, namespace)
                    if namespace is not None else None)
    links = link_view(namespace, dispatch)
    stat_path = (functools.partial(path_stat, dispatch)
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
            stdin=stdin,
            cwd=session.cwd,
            dispatch=dispatch,
            session_id=session.session_id,
            env=session.env,
            exec_allowed=registry.is_exec_allowed(),
            runtime=line_runtime,
            runtime_unavailable=registry.runtime_unavailable.get(cmd_name),
            stat_overlay=stat_overlay,
            links=links,
            stat_path=stat_path,
            mounts=mount_view(registry),
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
        return None, IOResult(exit_code=1,
                              stderr=format_fs_error(cmd_name, exc, paths))

    # A minor problem (exit 1: an entry below the operand could not be
    # stat'd) still lists the directory, so the mount and link rows belong
    # in that output; only a failed operand (exit 2) has nothing to augment.
    if cmd_name == "ls" and io.exit_code != LS_FAILURE:
        stdout = await inject_child_mounts(stdout, registry, paths,
                                           flag_kwargs, session.cwd)

    if cmd_name == "find":
        stdout, action_err = await _apply_find_actions(stdout, flag_kwargs,
                                                       registry, session.cwd)
        if action_err:
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = existing + action_err
            if io.exit_code == 0:
                io.exit_code = 1

    prefix = mount.prefix.rstrip("/")
    if prefix:
        io.reads = {prefix + k: v for k, v in io.reads.items()}
        io.writes = {prefix + k: v for k, v in io.writes.items()}
        io.cache = [prefix + p for p in io.cache]
    return wrap_cachable_streams(stdout, io)


def listed_names(existing: str, long_form: bool) -> set[str]:
    """Names already rendered in an ls listing, for injection dedup.

    Long rows come in two shapes: the degraded ``mode\t-\t-\tname``
    form used for entries with neither size nor mtime, and the full GNU
    row whose name is the ninth whitespace-separated field. Splitting on
    tabs alone reads a full row as a single field, so a name would never
    match and an injected row could duplicate an entry the backend
    already listed.

    Args:
        existing (str): the backend's rendered ls output.
        long_form (bool): whether -l rows are being parsed.
    """
    names: set[str] = set()
    for line in existing.split("\n"):
        if line == "":
            continue
        if not long_form:
            names.add(line.rstrip("/*@|="))
        elif "\t" in line:
            names.add(line.split("\t")[-1])
        else:
            parts = line.split(maxsplit=8)
            if len(parts) == 9:
                names.add(parts[8])
    names.discard("")
    return names


async def inject_child_mounts(
    stdout: ByteSource | None,
    registry: MountRegistry,
    paths: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    cwd: str,
) -> ByteSource | None:
    if flag_kwargs.get("d") is True or flag_kwargs.get("R") is True:
        return stdout
    if len(paths) > 1:
        return stdout
    listed = paths[0].virtual if paths else cwd
    include_hidden = (flag_kwargs.get("a") is True
                      or flag_kwargs.get("A") is True)
    child_names = registry.child_mount_names(listed, include_hidden)
    if not child_names:
        return stdout

    existing_bytes = await materialize(stdout) if stdout is not None else b""
    existing = existing_bytes.decode("utf-8")
    long_form = flag_kwargs.get("args_l") is True
    classify = flag_kwargs.get("F") is True
    present = listed_names(existing, long_form)
    extras: list[str] = []
    for name in child_names:
        if name in present:
            continue
        if long_form:
            extras.append(f"d\t-\t-\t{name}")
        else:
            extras.append(f"{name}/" if classify else name)
    if not extras:
        return stdout
    sep = "" if existing == "" or existing.endswith("\n") else "\n"
    return (existing + sep + "\n".join(extras)).encode("utf-8")
