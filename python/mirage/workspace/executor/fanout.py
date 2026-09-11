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

import dataclasses
from collections.abc import Sequence
from dataclasses import dataclass

from mirage.commands.builtin.find_eval import FindEntry, keep
from mirage.commands.builtin.find_parse import parse_find_expression
from mirage.commands.builtin.generic.crossmount.fanout.du import \
    merge_du_blocks
from mirage.commands.builtin.generic.crossmount.types import RunSingle
from mirage.commands.config import ExecContext
from mirage.commands.errors import FindParseError
from mirage.commands.spec.types import FlagValue
from mirage.context import path_allowed
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.ops.types import NamespaceView, StatPath
from mirage.types import FileType, PathSpec, Producer
from mirage.utils.dates import matches_mtime
from mirage.utils.path import respell_one
from mirage.workspace.mount import (MountCommandUnsupported, MountEntry,
                                    MountRegistry)
from mirage.workspace.types import ExecutionNode

# `tree` is deliberately absent: its output is one document (root line,
# drawing, summary), so a second per-mount block would print a second of
# each. It crosses the boundary inside the generic instead.
_TRAVERSAL_CMDS = frozenset({"find", "du"})


@dataclass(frozen=True, slots=True)
class _DuFanFlags:
    a: bool
    s: bool
    c: bool
    human: bool
    max_depth: int | None
    separate_dirs: bool


def _path_segments(path: str) -> list[str]:
    return [s for s in path.strip("/").split("/") if s]


async def _mount_dirs(descendants: Sequence[MountEntry],
                      stat_path: StatPath | None) -> list[str]:
    """The descendant mount roots that are directories.

    A mount root is not always one: `/.bash_history` is a whole mount
    serving a single file. du's merge has to tell them apart because a
    directory with no content still earns GNU's ``0`` row while a file
    only shows under ``-a``, and rendered du output cannot say which it
    was looking at. Without a dispatcher the question cannot be asked,
    and the merge falls back to inferring from the row shape.

    Args:
        descendants (Sequence[MountEntry]): the mounts under the operand.
        stat_path (StatPath | None): dispatcher-backed stat.
    """
    if stat_path is None:
        return []
    out: list[str] = []
    for m in descendants:
        root = m.prefix.rstrip("/") or "/"
        stat = await stat_path(root)
        if stat is not None and stat.type is FileType.DIRECTORY:
            out.append(root)
    return out


async def _ls_block_mounts(descendants: Sequence[MountEntry],
                           stat_path: StatPath | None) -> list[MountEntry]:
    """The descendants `ls -R` should render a block for.

    A mount root is not always a directory (`/.bash_history` is a whole
    mount serving one file), and GNU lists a file that happens to be a
    mountpoint as an ordinary row of its parent with no block of its own
    -- pinned on coreutils 9.7 over a `mount --bind` of one file onto
    another. The parent's listing already carries that row, because ls
    stats every child mount through this same dispatcher, so a sub-run
    would print the name a second time.

    Only a *confirmed* non-directory is dropped: a root the dispatcher
    cannot stat keeps its block rather than vanishing on a failed probe,
    and without a dispatcher at all the question cannot be asked and
    every descendant stands.

    Args:
        descendants (Sequence[MountEntry]): the mounts under the operand.
        stat_path (StatPath | None): dispatcher-backed stat.
    """
    if stat_path is None:
        return list(descendants)
    kept: list[MountEntry] = []
    for m in descendants:
        stat = await stat_path(m.prefix.rstrip("/") or "/")
        if stat is None or stat.type is FileType.DIRECTORY:
            kept.append(m)
    return kept


def _allowed_descendants(registry: MountRegistry,
                         path: str) -> list[MountEntry]:
    """Descendant mounts the current session may see.

    A fan-out rooted above a session boundary must not walk into an
    ungranted mount: enumerating it through the raw registry is exactly
    how `grep -r x /` leaked a walled-off mount's contents. The filter
    matches the door's structure merge, so the fan-out stays an
    unobservable optimization.

    Args:
        registry (MountRegistry): registry holding the mount table.
        path (str): parent path to scan beneath.
    """
    return [
        m for m in registry.descendant_mounts(path)
        if path_allowed("/" + m.prefix.strip("/"))
    ]


def _depth_flag_value(raw: FlagValue | None) -> int | None:
    if isinstance(raw, list):
        raw = raw[0] if raw else None
    if isinstance(raw, bool) or not isinstance(raw, (str, int)):
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _should_fan_out(
    cmd_name: str,
    paths: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    registry: MountRegistry,
) -> bool:
    """Whether `cmd` on this path should run across multiple mounts.

    True when the command is in the traversal whitelist (find/du)
    and the path has at least one descendant mount; or for grep with
    -r/-R; or for ls -R. Returns False when there's no descendant
    mount under the path (single-mount dispatch is correct).
    """
    if not paths:
        return False
    target = paths[0].virtual
    # Gated on the raw registry, not the session view: with every
    # descendant ungranted, single-mount dispatch would serve the parent
    # backend's keys shadowed under a hidden mount's prefix, and only
    # the fan-out's shadow filter drops those. Execution still runs the
    # allowed descendants only.
    if not registry.descendant_mounts(target):
        return False
    if cmd_name in _TRAVERSAL_CMDS:
        return True
    if cmd_name == "grep":
        return (flag_kwargs.get("r") is True or flag_kwargs.get("R") is True
                or flag_kwargs.get("recursive") is True)
    if cmd_name == "rg":
        # ripgrep recurses directories by default; no flag to check.
        return True
    if cmd_name == "ls":
        return flag_kwargs.get("R") is True
    return False


def _adjust_depth_flags(
    flag_kwargs: dict[str, FlagValue],
    parent_path: str,
    mount_prefix: str,
) -> dict[str, FlagValue] | None:
    """Adjust find's -maxdepth/-mindepth for a fan-out into a child mount.

    Returns the new kwargs dict, or None if the child mount falls
    outside the depth budget (caller should skip it).
    """
    parent_depth = len(_path_segments(parent_path))
    mount_depth = len(_path_segments(mount_prefix))
    delta = mount_depth - parent_depth
    new = dict(flag_kwargs)
    if "maxdepth" in new:
        raw_md = _depth_flag_value(new["maxdepth"])
        md = raw_md - delta if raw_md is not None else None
        if md is not None:
            if md < 0:
                return None
            new["maxdepth"] = str(md)
    if "mindepth" in new:
        raw_mn = _depth_flag_value(new["mindepth"])
        if raw_mn is not None:
            mn = max(0, raw_mn - delta)
            new["mindepth"] = str(mn)
    return new


def _adjust_depth_texts(
    texts: list[str],
    parent_path: str,
    mount_prefix: str,
) -> list[str]:
    """Adjust -maxdepth/-mindepth values inside a find expression.

    The generic find parses depth from the expression tokens (`texts`),
    not from flag kwargs, so a fan-out into a deeper child mount must
    rewrite the depth values by the parent-to-mount delta. Mirrors
    `_adjust_depth_flags`.

    Args:
        texts (list[str]): the find expression tokens.
        parent_path (str): the find start path the fan-out runs from.
        mount_prefix (str): the child mount prefix being descended into.
    """
    delta = len(_path_segments(mount_prefix)) - len(
        _path_segments(parent_path))
    if delta == 0:
        return list(texts)
    out = list(texts)
    i = 0
    while i < len(out) - 1:
        tok = out[i]
        if tok in ("-maxdepth", "-mindepth"):
            try:
                val = int(out[i + 1])
            except ValueError:
                i += 2
                continue
            if tok == "-maxdepth":
                out[i + 1] = str(val - delta)
            else:
                out[i + 1] = str(max(0, val - delta))
            i += 2
            continue
        i += 1
    return out


async def _synthesize_find_mount_entries(
    target_path: str,
    descendants: list[MountEntry],
    texts: list[str],
    raw: str,
    stat_path: StatPath | None = None,
) -> list[PathSpec]:
    """Return synthetic find paths for descendant mount roots.

    `find /` and friends should list mount prefixes as directory
    entries even though no per-mount find emits its own root. The
    namespace-only ancestors between the start and each mount root
    (`/ghost` above a mount at `/ghost/deep`) get a row too: no
    backend walk covers them, yet `ls` lists them through the door's
    structure merge, so find must agree. The find expression is parsed
    into a predicate tree and evaluated per entry (kind "d"),
    mirroring the per-backend cores, so -not / -o / -path / -type and
    the -maxdepth / -mindepth window all apply. A time window
    (``-newermt``, ``-newer``) lives beside the tree, so a candidate is
    statted through the dispatcher and held to it the way the generic
    holds every real row, a future cutoff excluding the mount points
    too. Entries print in the operand's typed spelling like every other
    line of the walk.

    Args:
        target_path (str): the find start path the fan-out runs from.
        descendants (list): descendant mounts to inject as entries.
        texts (list[str]): the find expression tokens.
        raw (str): the operand's typed spelling (``PathSpec.raw_path``).
        stat_path (StatPath | None): dispatcher stat, for the time
            window; None (no window can be checked) keeps the rows.
    """
    try:
        expr = parse_find_expression(list(texts))
    except FindParseError:
        return []
    tree = expr.tree
    max_depth = expr.maxdepth
    min_depth = expr.mindepth if expr.mindepth is not None else 0
    parent_depth = len(_path_segments(target_path))
    parent_base = target_path.rstrip("/")
    seen: set[str] = set()
    out: list[PathSpec] = []
    for m in descendants:
        prefix_no_slash = m.prefix.rstrip("/")
        ancestors: list[str] = []
        parent = prefix_no_slash.rsplit("/", 1)[0]
        while parent and parent != parent_base:
            ancestors.append(parent)
            parent = parent.rsplit("/", 1)[0]
        for candidate in [*reversed(ancestors), prefix_no_slash]:
            if candidate in seen:
                continue
            seen.add(candidate)
            depth = len(_path_segments(candidate)) - parent_depth
            if max_depth is not None and depth > max_depth:
                continue
            base = candidate.rsplit("/", 1)[-1] or candidate
            entry = FindEntry(key=candidate, name=base, kind="d", depth=depth)
            if not keep(entry, tree, min_depth):
                continue
            if ((expr.mtime_min is not None or expr.mtime_max is not None)
                    and stat_path is not None):
                st = await stat_path(candidate)
                if st is None or not matches_mtime(st.modified, expr.mtime_min,
                                                   expr.mtime_max):
                    continue
            out.append(
                PathSpec(virtual=candidate,
                         directory=candidate,
                         resource_path="",
                         resolved=True,
                         raw_path=respell_one(candidate, target_path, raw)))
    return out


def _drop_shadowed_ls_groups(text: str,
                             descendant_prefixes: list[str]) -> list[str]:
    """Drop whole ``ls -R`` groups whose header names a nested mount.

    ``ls -R`` renders ``PATH:``, then that directory's bare names, with a
    blank line between groups. Reading a path off every line drops the
    header and keeps the names, so a shadowed directory's entries land at
    the end of the previous group, which is how ``leftover.txt`` came to
    be listed as a child of ``/base``.

    Args:
        text (str): the parent mount's rendered listing.
        descendant_prefixes (list[str]): mount roots strictly under the
            operand, without their trailing slash.
    """
    kept: list[str] = []
    skipping = False
    for line in text.split("\n"):
        header = line[:-1] if line.endswith(":") else None
        if header is not None and header.startswith("/"):
            skipping = any(header == pre or header.startswith(pre + "/")
                           for pre in descendant_prefixes)
            if skipping:
                # The blank line ahead of a dropped group would otherwise
                # be left dangling at the end of the block.
                if kept and kept[-1] == "":
                    kept.pop()
                continue
        elif skipping:
            continue
        kept.append(line)
    while kept and kept[-1] == "":
        kept.pop()
    return kept


async def _filter_under_prefixes(
    stdout: ByteSource,
    descendant_prefixes: list[str],
    cmd_name: str,
) -> bytes:
    """Drop lines whose path falls under any descendant mount prefix.

    ``du`` renders ``SIZE\\tPATH``, so its path is everything after the
    first tab; ``ls -R`` renders groups and is filtered a group at a
    time; for the path-first formats (find, grep) the path is the start
    of the line up to the first tab or colon. Lines whose path does not
    start with `/` are passed through.
    """
    data = await materialize(stdout)
    text = data.decode("utf-8", errors="replace")
    if cmd_name == "ls":
        grouped = _drop_shadowed_ls_groups(text, descendant_prefixes)
        return ("\n".join(grouped) + "\n").encode("utf-8") if grouped else b""
    out_lines: list[str] = []
    for line in text.split("\n"):
        if line == "":
            continue
        path = line
        if cmd_name == "du":
            _, tab, rest = line.partition("\t")
            path = rest if tab else line
        else:
            for sep in ("\t", ":"):
                if sep in path:
                    path = path.split(sep, 1)[0]
                    break
        if path.startswith("/"):
            shadowed = False
            for pre in descendant_prefixes:
                if path == pre or path.startswith(pre + "/"):
                    shadowed = True
                    break
            if shadowed:
                continue
        out_lines.append(line)
    return ("\n".join(out_lines) + "\n").encode("utf-8") if out_lines else b""


async def _fan_out_traversal(
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    registry: MountRegistry,
    primary_mount: MountEntry,
    cwd: str,
    cmd_str: str,
    stdin: ByteSource | None,
    ns: NamespaceView | None = None,
    stat_path: StatPath | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a traversal command across the parent mount + descendant mounts.

    Each mount runs the command with its own root as the path argument
    (depth flags adjusted for find/tree). Outputs are concatenated in
    mount-prefix-sorted order, except single-operand find, whose merged
    lines are path-sorted (see below). The parent mount's output is
    filtered to drop lines that fall under any descendant mount (avoids
    duplicates when the parent's resource has shadowed keys).

    For `find`, mount-prefix paths themselves are injected as synthetic
    directory entries (subject to depth and -type filters) because
    mirage's per-mount find doesn't emit the path argument itself.

    ``ns`` is offered to every sub-run whole. The boundary facts,
    because a rollup total cannot be repaired by line filtering: du must
    exclude a shadowed subtree while it is accounting, not after it has
    rendered. The symlink facts, for the same reason the single-mount
    path offers them: symlinks are namespace state, so a sub-run that
    never receives them reports a tree with every link missing, and a
    nested mount is not a reason for ``find`` to stop seeing one.
    """
    target_path = paths[0].virtual
    descendants = _allowed_descendants(registry, target_path)
    if cmd_name == "ls":
        descendants = await _ls_block_mounts(descendants, stat_path)
    # The shadow filter keeps the raw list on purpose: a mount the
    # session cannot see still shadows the primary backend's keys under
    # its prefix, the walk just never descends into it.
    descendant_prefixes = [
        m.prefix.rstrip("/") for m in registry.descendant_mounts(target_path)
    ]

    # A nested mount's bytes belong to every directory above it, so du's
    # blocks are folded into one tree rather than concatenated
    # (`merge_du_blocks`). The runs are asked for every row in absolute
    # spelling and exact bytes, because the merge needs the leaves back:
    # -a keeps the file rows, -s would collapse them, a depth limit would
    # prune them, and humanized sizes cannot be re-summed. Every one of
    # those is then applied once, centrally.
    du_merge = cmd_name == "du"
    du_flags = _DuFanFlags(a=flag_kwargs.get("a") is True,
                           s=flag_kwargs.get("s") is True,
                           c=flag_kwargs.get("c") is True,
                           human=flag_kwargs.get("h") is True,
                           max_depth=_depth_flag_value(
                               flag_kwargs.get("max_depth")),
                           separate_dirs=flag_kwargs.get("separate_dirs")
                           is True)
    if du_merge:
        flag_kwargs = {
            **flag_kwargs, "a": True,
            "s": False,
            "c": False,
            "h": False,
            "separate_dirs": False
        }
        flag_kwargs.pop("max_depth", None)

    all_stdout: list[bytes] = []
    find_matches: list[list[PathSpec]] = []
    find_matches_complete = True
    merged_io = IOResult()
    final_exit = 0
    success_seen = False
    for mount in [primary_mount] + list(descendants):
        if mount is primary_mount:
            # The du merge re-spells centrally, so the runs answer in
            # absolute virtual paths: a relative operand would otherwise
            # come back already spelled and could not be rebased onto the
            # tree the rollup builds.
            sub_paths = [
                dataclasses.replace(paths[0], raw_path=target_path), *paths[1:]
            ] if du_merge else list(paths)
            sub_flags = dict(flag_kwargs)
            sub_texts = list(texts)
        else:
            mount_root = mount.prefix.rstrip("/") or "/"
            adjusted = _adjust_depth_flags(flag_kwargs, target_path,
                                           mount.prefix)
            if adjusted is None:
                continue
            sub_flags = adjusted
            if cmd_name == "rg":
                # A tree search labels every hit; a descendant mount
                # whose root is a single file would otherwise drop the
                # filename (rg labels only multi-file or -H runs).
                sub_flags["H"] = True
            sub_texts = _adjust_depth_texts(texts, target_path, mount.prefix)
            # The descendant operand keeps the traversal root's typed
            # spelling (grep -r . -> ./ram/...; the synthetic bare
            # no-operand form -> ram/...); an absolute root leaves it
            # absolute, the pre-existing output shape.
            sub_paths = [
                PathSpec(virtual=mount_root,
                         directory=mount_root,
                         resource_path="",
                         resolved=True,
                         raw_path=mount_root if du_merge else respell_one(
                             mount_root, target_path, paths[0].raw_path))
            ]
        stdout, io = await mount.execute_cmd(
            cmd_name, sub_paths, sub_texts, sub_flags,
            ExecContext(stdin=stdin, cwd=cwd, ns=ns, stat_path=stat_path))

        if mount is not primary_mount and io.exit_code == 127:
            # A descendant that does not serve this command contributes
            # nothing to the aggregate walk instead of failing it (du
            # across a tree holding a view mount without a du op).
            continue
        if cmd_name == "find" and io.matched_runs is not None:
            if mount is primary_mount:
                # One run per operand, minus the rows a descendant
                # mount answers for.
                find_matches.extend([
                    p for p in run if not any(
                        p.virtual == pre or p.virtual.startswith(pre + "/")
                        for pre in descendant_prefixes)
                ] for run in io.matched_runs)
            else:
                # A descendant walks under the first operand, so its
                # rows join that operand's run.
                rows = [
                    p for run in io.matched_runs for p in run
                    if p.virtual != mount.prefix.rstrip("/")
                ]
                if find_matches:
                    find_matches[0].extend(rows)
                else:
                    find_matches.append(rows)
            stdout = None
        elif mount is primary_mount and descendant_prefixes and stdout:
            stdout = await _filter_under_prefixes(stdout, descendant_prefixes,
                                                  cmd_name)

        if stdout is not None:
            data = await materialize(stdout)
            if data:
                if cmd_name == "find":
                    find_matches_complete = False
                all_stdout.append(data)
        if io.exit_code == 0:
            success_seen = True
        elif final_exit == 0:
            final_exit = io.exit_code
        merged_io = await merged_io.merge(io)

    all_rows: list[PathSpec] = []
    if cmd_name == "find":
        synthetic = await _synthesize_find_mount_entries(
            target_path, descendants, texts, paths[0].raw_path, stat_path)
        # The mount points a walk cannot see belong to the first
        # operand's run, the one that holds them.
        if synthetic:
            if find_matches:
                find_matches[0].extend(synthetic)
            else:
                find_matches.append(synthetic)
        all_rows = [p for run in find_matches for p in run]
        if not find_matches_complete and all_rows:
            all_stdout.append(("\n".join(p.raw_path or p.virtual
                                         for p in all_rows) + "\n").encode())

    combined: ByteSource | None
    if du_merge and all_stdout:
        combined = merge_du_blocks(all_stdout,
                                   target_path,
                                   paths[0].raw_path,
                                   a=du_flags.a,
                                   s=du_flags.s,
                                   c=du_flags.c,
                                   human=du_flags.human,
                                   max_depth=du_flags.max_depth,
                                   separate_dirs=du_flags.separate_dirs,
                                   mount_roots=await
                                   _mount_dirs(descendants, stat_path))
    elif cmd_name == "find" and all_rows and find_matches_complete:
        if len(paths) == 1:
            unique = {p.virtual: p for p in all_rows}
            find_matches = [sorted(unique.values(), key=lambda p: p.raw_path)]
            all_rows = find_matches[0]
        combined = ("\n".join(p.raw_path or p.virtual
                              for p in all_rows) + "\n").encode("utf-8")
    elif all_stdout:
        # `ls -R` separates directory groups with a blank line, and a
        # per-mount block is one more group; every other format is a
        # plain line stream.
        sep = b"\n\n" if cmd_name == "ls" else b"\n"
        combined = sep.join(b.rstrip(b"\n") for b in all_stdout) + b"\n"
    else:
        combined = None
    # grep exits 0 when ANY mount matched (GNU: "any line was selected");
    # traversal commands (find/du/tree) keep the first per-mount failure.
    if cmd_name in ("grep", "rg") and success_seen:
        final_io_exit = 0
    else:
        final_io_exit = final_exit

    if cmd_name == "find":
        # The structured rows ride out for the command boundary, which
        # applies find's actions once over every operand's matches.
        merged_io.matched_runs = (find_matches
                                  if find_matches_complete else None)

    merged_io.exit_code = final_io_exit
    merged_io.producer = Producer(
        command=cmd_name,
        prefixes=tuple(m.prefix for m in [primary_mount, *descendants]))
    exec_node = ExecutionNode(command=cmd_str,
                              exit_code=final_io_exit,
                              stderr=await materialize(merged_io.stderr))
    return combined, merged_io, exec_node


async def run_with_fanout(
    run_single: RunSingle,
    registry: MountRegistry,
    cwd: str,
    ns: NamespaceView | None,
    stat_path: StatPath | None,
    cmd_name: str,
    paths: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
    *,
    stdin: ByteSource | None = None,
    resolve_hint: PathSpec | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """One operand's native run, fanned out over the mounts nested in it.

    A line whose operands span mounts runs once per operand on the
    operand's owning mount, and that runner is single-mount by
    construction: it never descends into a mount nested *under* the
    operand. So ``du /base /other`` reported the parent backend's keys
    shadowed by a mount at ``/base/inner`` and none of that mount's own,
    while ``du /base`` on the same tree got both right. Wrapping the
    per-operand runner is what makes the two agree, and it is a
    pass-through for everything the traversal fan-out does not claim.

    Args:
        run_single (RunSingle): the executor's single-mount runner.
        registry (MountRegistry): registry holding the mount table.
        cwd (str): session working directory.
        ns (NamespaceView | None): the name plane's facts, offered
            whole to the sub-runs.
        stat_path (StatPath | None): dispatcher-backed stat of one path.
        cmd_name (str): command name.
        paths (list[PathSpec]): this operand, as a one-element list.
        texts (list[str]): positional text operands.
        flag_kwargs (dict): parsed flags.
        stdin (ByteSource | None): standard input for the command.
        resolve_hint (PathSpec | None): mount-resolution path for a run
            with no operand of its own (the stream strategy's single
            native run over the merged bytes).
    """
    if not _should_fan_out(cmd_name, paths, flag_kwargs, registry):
        return await run_single(cmd_name,
                                paths,
                                texts,
                                flag_kwargs,
                                stdin=stdin,
                                resolve_hint=resolve_hint)
    try:
        mount = await registry.resolve_mount(cmd_name, paths, cwd)
    except MountCommandUnsupported:
        # The single-mount runner owns the wording for a command this
        # mount does not serve, so let it report rather than re-raising.
        mount = None
    if mount is None:
        return await run_single(cmd_name,
                                paths,
                                texts,
                                flag_kwargs,
                                stdin=stdin,
                                resolve_hint=resolve_hint)
    stdout, io, _ = await _fan_out_traversal(cmd_name,
                                             paths,
                                             texts,
                                             flag_kwargs,
                                             registry,
                                             mount,
                                             cwd,
                                             cmd_name,
                                             stdin,
                                             ns=ns,
                                             stat_path=stat_path)
    return stdout, io
