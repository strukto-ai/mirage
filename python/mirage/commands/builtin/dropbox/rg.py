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

from collections.abc import Mapping

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.dropbox.io import IO as _IO
from mirage.commands.builtin.dropbox.narrow import narrow_scope
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind import default_provision
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.dropbox.read import read as _read
from mirage.core.dropbox.read import stream as _stream
from mirage.core.dropbox.readdir import readdir as _readdir
from mirage.core.dropbox.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _keep_visible(
    narrowed: list[PathSpec],
    scopes: list[PathSpec],
    hidden: bool,
) -> list[PathSpec]:
    """Reproduce rg's dotfile pruning for search-narrowed candidates.

    The generic rg walk skips hidden files and never descends into hidden
    directories, but explicit file operands bypass that pruning, so
    narrowed candidates are filtered on every path segment below their
    (longest-matching) scope.

    Args:
        narrowed (list[PathSpec]): search-narrowed candidate files.
        scopes (list[PathSpec]): the original scope operands.
        hidden (bool): True if --hidden is set (no pruning).
    """
    if hidden:
        return narrowed
    kept: list[PathSpec] = []
    for p in narrowed:
        rel = p.virtual
        best = -1
        for scope in scopes:
            base = scope.virtual.rstrip("/")
            if len(base) > best and (p.virtual == base
                                     or p.virtual.startswith(base + "/")):
                rel = p.virtual[len(base):]
                best = len(base)
        if any(seg.startswith(".") for seg in rel.split("/") if seg):
            continue
        kept.append(p)
    return kept


@command("rg",
         resource="dropbox",
         spec=SPECS["rg"],
         provision=default_provision("rg",
                                     _IO.stat,
                                     resolve_glob=_IO.resolve_glob,
                                     readdir=_IO.readdir))
async def rg(
    accessor: DropboxAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    prefix: str = "",
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)

    run_flags: Mapping[str, object] = flags
    if paths:
        # -v needs the walk (a narrowed superset hides fully non-matching
        # files whose every line matches inverted); --type/--glob keep the
        # walk so their file filtering stays in one place.
        narrowed, used_search = await narrow_scope(
            accessor,
            index,
            paths,
            pattern_str,
            fixed_string=fl.as_bool("F"),
            recursive=True,
            exact_file_set=(fl.as_bool("v") or fl.as_str("type") is not None
                            or fl.as_str("glob") is not None),
        )
        if used_search:
            narrowed = _keep_visible(narrowed, paths, fl.as_bool("hidden"))
            if not narrowed:
                return b"", IOResult(exit_code=1)
            # ripgrep labels every file a walk finds; narrowed candidates
            # arrive as explicit operands, so force the label flag —
            # unless -I suppresses labels.
            if not fl.as_bool("args_I"):
                run_flags = {**flags, "H": True}
        paths = narrowed

    return await generic_rg(
        paths,
        texts,
        run_flags,
        readdir=bound_op(_readdir, accessor, index),
        stat=bound_op(_stat, accessor, index),
        read_bytes=bound_op(_read, accessor, index),
        read_stream=bound_op(_stream, accessor, index),
        stdin=stdin,
    )
