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

from collections.abc import Callable
from dataclasses import replace
from functools import partial
from typing import Any, cast

from mirage.commands.builtin.find_eval import tree_has_mtime
from mirage.commands.builtin.find_parse import FindExpr, parse_find_expression
from mirage.commands.builtin.generic.find import (
    find_generic,
    find_walk_generic,
)
from mirage.commands.builtin.generic_bind.adapter import (
    mount_io,
    with_command_guards,
    with_policy_guard,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.generic.find import make_search_backed_find
from mirage.core.slug_tree.tree import SlugTree
from mirage.core.slug_tree.types import A
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.types import StatOp
from mirage.view.namespace_view import paths_scoped


def reads_times(expr: FindExpr) -> bool:
    """Whether the expression tests a timestamp. ``-printf`` and ``-ls``
    are not tests: they stat through the dispatcher.

    Args:
        expr (FindExpr): the parsed expression.
    """
    return bool(expr.newer) or tree_has_mtime(expr.tree)


def reads_sizes(expr: FindExpr) -> bool:
    """Whether the expression tests a file size (``-empty`` compares one
    with zero).

    Args:
        expr (FindExpr): the parsed expression.
    """
    return (
        expr.min_size is not None
        or expr.max_size is not None
        or expr.uses_empty
    )


def _flags_test(fl: FlagView) -> bool:
    """Whether the flag bag carries a size or time test. Only a direct
    call hands tests over as flags; the shell passes them as words.

    Args:
        fl (FlagView): the find flags.
    """
    return (
        fl.as_str("size") is not None
        or fl.as_str("mtime") is not None
        or fl.as_bool("empty")
    )


def _is_bare_name(texts: list[str]) -> bool:
    return (
        bool(texts)
        and not texts[0].startswith("-")
        and texts[0] not in ("(", ")", "!")
    )


def _default_name(name: str | None, texts: list[str]) -> str | None:
    if name is not None:
        return name
    if _is_bare_name(texts):
        return texts[0]
    return None


def _expr_texts(texts: list[str]) -> list[str]:
    if _is_bare_name(texts):
        return []
    return texts


async def _normalize_find_output(
    stdout: ByteSource | None,
    search_path: PathSpec,
) -> ByteSource | None:
    if stdout is None:
        return None
    data = await materialize(stdout)
    root = (
        mount_prefix_of(search_path.virtual, search_path.vfs_path).rstrip("/")
        or "/"
    )
    lines = data.decode().splitlines()
    normalized = [root if line == root + "/" else line for line in lines]
    return format_records(normalized)


def make_find(
    vfs: str,
    tree: SlugTree[A],
    stat: StatOp,
    stat_light: StatOp,
    needs_full: Callable[[FindExpr], bool],
) -> Callable[..., Any]:
    """Build ``find`` for a slug-tree backend, filtered over one tree walk.

    Args:
        vfs (str): the backend the command registers for.
        tree (SlugTree[A]): the backend's tree.
        stat (StatOp): the full stat.
        stat_light (StatOp): the index-only stat, used unless the
            expression tests a field it lacks.
        needs_full (Callable[[FindExpr], bool]): whether an expression
            tests a field ``stat_light`` lacks: ``reads_sizes`` where the
            size costs a content scan, ``reads_times`` where the listing
            carries no modified time.
    """
    find_full = make_search_backed_find(tree.resolve, stat, tree.walk)
    find_light = make_search_backed_find(tree.resolve, stat_light, tree.walk)

    @command("find", vfs=vfs, spec=SPECS["find"])
    async def find(
        accessor: A,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        io = mount_io(opts)
        paths = default_paths(paths, opts.cwd)
        paths = await io.resolve_glob(accessor, paths, opts.index)
        search_path = paths[0]

        fl = FlagView(opts.flags, spec=SPECS["find"])
        # Push-down choices: a bare word acts as the -name filter, and the
        # heavier stat is only paid when a test needs what it adds.
        bag = dict(opts.flags)
        default_name = _default_name(fl.as_str("name"), texts)
        if default_name is not None:
            bag["name"] = default_name
        words = _expr_texts(texts)
        full = (
            needs_full(parse_find_expression(words))
            if words
            else _flags_test(fl)
        )
        # A native find op classifies on the raw backend tree, so under
        # hidden paths or a path rule it would answer for entries the
        # session cannot see; the walk classifies through the guarded
        # readdir/stat, the same fork the factory builder takes (rung 0).
        if paths_scoped(opts.ns, paths):
            walk_io = with_command_guards(
                with_policy_guard(io if full else replace(io, stat=stat_light))
            )
            stdout, result = await find_walk_generic(
                paths,
                words,
                replace(opts, flags=bag),
                readdir=partial(walk_io.readdir, accessor),
                stat=partial(walk_io.stat, accessor),
            )
            return await _normalize_find_output(stdout, search_path), result
        stdout, result = await find_generic(
            paths,
            words,
            replace(opts, flags=bag),
            find_core=partial(
                find_full if full else find_light, accessor, index=opts.index
            ),
            stat=partial(
                stat if full else stat_light, accessor, index=opts.index
            ),
        )
        return await _normalize_find_output(stdout, search_path), result

    return cast(Callable[..., Any], find)
