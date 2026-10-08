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

from collections.abc import AsyncIterator
from dataclasses import replace
from typing import cast

from mirage.commands.builtin.constants import BINARY_EXTENSIONS
from mirage.commands.builtin.generic.crossmount.fanout.exit import (
    combined_exit,
)
from mirage.commands.builtin.generic.crossmount.scopes import (
    owned_scopes,
)
from mirage.commands.builtin.generic.crossmount.types import (
    CrossResult,
    OperandRun,
    OwnedScope,
    RunSingle,
)
from mirage.commands.builtin.generic.crossmount.utils import (
    merge_operand_ios,
    run_operands,
    run_separator,
)
from mirage.commands.builtin.generic.grep import filename_mode, parse_flags
from mirage.commands.builtin.generic.rg import (
    filters_files,
    haystacks,
    label_flags,
    rg_matcher,
    sort_haystacks,
    walk_filter,
    walks_descendant_mounts,
)
from mirage.commands.builtin.generic.rg import (
    parse_flags as parse_rg_flags,
)
from mirage.commands.builtin.grep_binary import GrepFlags
from mirage.commands.builtin.grep_pattern import compile_pattern, pattern_arg
from mirage.commands.builtin.grep_select import dir_admitted, file_admitted
from mirage.commands.builtin.rg_scan import walk_error_line
from mirage.commands.builtin.utils.links import LinkDoor
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.resolve import get_extension
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagBag, FlagView
from mirage.commands.spec.types import FlagValue
from mirage.doors.types import NamespaceView
from mirage.errors.render import fs_error_line
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, FileType, PathSpec


def _admit_grep(flags: GrepFlags, path: PathSpec, info: FileStat) -> bool:
    if info.type == FileType.DIRECTORY:
        return dir_admitted(path.virtual, flags.filters)
    return (
        info.type == FileType.FILE
        and file_admitted(path.virtual, flags.filters)
        and (
            flags.filters.text
            or get_extension(path.virtual) not in BINARY_EXTENSIONS
        )
    )


async def run_search(
    name: str,
    paths: list[PathSpec],
    texts: list[str],
    flags: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    cwd: str,
    ns: NamespaceView | None = None,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Compose the registered search handlers, preserving operand order.

    Recursive search delegates only scopes whose backend owns every entry.
    A search with global walk state (rg sorting, depth and link following)
    uses its existing metadata walker before delegating selected files.
    Content always stays with the registered handler.

    Args:
        name (str): grep or rg.
        paths (list[PathSpec]): Original operands, including repetitions.
        texts (list[str]): Prepared pattern operands.
        flags (dict[str, FlagValue]): Parsed options.
        dispatch (DispatchFn): Workspace operations.
        run_single (RunSingle): Full native command execution boundary.
        cwd (str): Working directory.
        ns (NamespaceView | None): Namespace ownership and link facts.
        stdin (ByteSource | None): Shared standard input.
    """
    view = FlagView(flags, spec=SPECS[name])
    grep = parse_flags(view, never_match=False) if name == "grep" else None
    rg = parse_rg_flags(view) if name == "rg" else None
    nested = bool(
        ns
        and ns.mounts
        and any(ns.mounts.descendants(p.virtual) for p in paths)
    )
    # A link can change the owner without appearing in the mount table.
    linked = bool(
        ns and ns.links and any(ns.links.subtree(p.virtual) for p in paths)
    )
    planned = rg is not None and (
        linked
        or rg.sort is not None
        or (
            nested
            and (
                rg.max_depth is not None
                or rg.follow
                or rg.one_file_system
                or filters_files(rg)
            )
        )
    )
    if rg is not None and rg.type_list:
        return await run_single(name, paths[:1], texts, flags)
    if grep is not None:
        pattern = pattern_arg(texts, view)
        if pattern is not None:
            compile_pattern(
                pattern,
                grep.ignore_case,
                grep.fixed_string,
                grep.whole_word,
                grep.syntax,
            )
    if rg is not None and not rg.list_files:
        pattern = pattern_arg(texts, view, "regexp")
        if pattern is not None:
            rg_matcher(pattern, False, rg)
    quiet = grep.quiet if grep is not None else bool(rg and rg.quiet)

    input_source = resolve_source(stdin)
    owners = [
        ns.mounts.root_of(p.virtual) if ns and ns.mounts else None
        for p in paths
    ]

    async def execute(
        cmd: str,
        operands: list[PathSpec],
        words: list[str],
        bag: dict[str, FlagValue],
    ) -> CrossResult:
        return await run_single(
            cmd,
            operands,
            words,
            bag,
            stdin=input_source if any(is_stdin(p) for p in operands) else None,
        )

    walk = walk_filter(rg) if rg is not None else None

    def admit(path: PathSpec, info: FileStat) -> bool:
        if grep is not None:
            return _admit_grep(grep, path, info)
        assert walk is not None
        name = path.virtual.rsplit("/", 1)[-1]
        if info.type == FileType.DIRECTORY:
            return walk.admits(path.virtual, name, True)
        return info.type == FileType.FILE and walk.admits_file(
            path.virtual, name, info
        )

    async def readdir(virtual: str) -> list[str]:
        data, _ = await dispatch("readdir", PathSpec.from_str_path(virtual))
        return cast(list[str], data)

    async def stat(virtual: str) -> FileStat:
        data, _ = await dispatch(
            "stat", PathSpec.from_str_path(virtual), nofollow=True
        )
        return cast(FileStat, data)

    async def scopes() -> AsyncIterator[OwnedScope]:
        if planned:
            assert rg is not None and walk is not None
            warnings: list[str] = []
            door = (
                LinkDoor(ns.links, dispatch, cwd) if ns and ns.links else None
            )
            found = haystacks(
                paths,
                readdir,
                stat,
                cwd,
                walk,
                rg,
                warnings,
                ns.mounts if ns and rg.one_file_system else None,
                door,
            )
            if rg.sort not in (None, "none") and not (
                rg.sort == "path" and not rg.sort_reverse
            ):
                listed = sort_haystacks([h async for h in found], rg)
                for message in warnings:
                    yield OwnedScope(paths[0], diagnostic=message + "\n")
                warnings.clear()
                for h in listed:
                    yield OwnedScope(
                        h.spec
                        or replace(
                            PathSpec.from_str_path(h.virtual), raw_path=h.shown
                        ),
                        h.spec is None,
                        h.stat,
                    )
                return
            async for h in found:
                for message in warnings:
                    yield OwnedScope(paths[0], diagnostic=message + "\n")
                warnings.clear()
                yield OwnedScope(
                    h.spec
                    or replace(
                        PathSpec.from_str_path(h.virtual), raw_path=h.shown
                    ),
                    h.spec is None,
                    h.stat,
                )
            for message in warnings:
                yield OwnedScope(paths[0], diagnostic=message + "\n")
            return
        for path in paths:
            if rg is not None or (grep is not None and grep.recursive):
                async for scope in owned_scopes(path, dispatch, ns, admit):
                    yield scope
            else:
                yield OwnedScope(path)

    results: list[OperandRun] = []
    async for scope in scopes():
        if scope.error is not None or scope.diagnostic is not None:
            message = scope.diagnostic
            if message is None:
                assert scope.error is not None
                message = (
                    (
                        walk_error_line(
                            scope.path.raw_path,
                            scope.error,
                            rg.threads != 1
                            and (len(paths) > 1 or scope.walked),
                        )
                        + "\n"
                    )
                    if rg is not None
                    else fs_error_line(name, scope.path, scope.error)
                )
            results.append(
                OperandRun(
                    scope.path,
                    b"",
                    IOResult(
                        exit_code=2,
                        stderr=encode_text(message)
                        if rg is None or not rg.no_messages
                        else None,
                    ),
                )
            )
            continue
        local = FlagBag(flags) if grep is not None else label_flags(flags)
        if grep is not None and filename_mode(view) is None:
            # A directory run already labels its files. Keep its native
            # search eligibility; only split file operands need explicit H.
            owner = (
                ns.mounts.root_of(scope.path.virtual)
                if ns and ns.mounts
                else None
            )
            repeated = owners.count(owner) > 1
            if (
                scope.stat is None
                or scope.stat.type != FileType.DIRECTORY
                or repeated
                or (
                    scope.walked
                    and not (
                        ns
                        and ns.mounts
                        and ns.mounts.is_root(scope.path.virtual)
                    )
                )
            ):
                local["H"] = True
        runs = await run_operands(execute, name, [scope.path], texts, local)
        results.extend(runs)
        if quiet and runs[-1].io.exit_code == 0:
            break
    code = combined_exit(
        name,
        [r.io.exit_code for r in results],
        [r.io.exit_code != 0 and r.io.stderr is not None for r in results],
        quiet,
    )
    body = run_separator(name, flags).join(r.data for r in results if r.data)
    return body, await merge_operand_ios(results, code)


def walks_mounts(name: str, flags: dict[str, FlagValue]) -> bool:
    """Whether this search crosses descendant mounts.

    Args:
        name (str): Command name.
        flags (dict[str, FlagValue]): Parsed options.
    """
    if name == "rg":
        return walks_descendant_mounts(flags)
    if name == "grep":
        view = FlagView(flags, spec=SPECS[name])
        return view.as_bool("r") or view.as_bool("R")
    return False
