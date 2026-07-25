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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.fmt import fmt as generic_fmt
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import (
    merge_split_errors, resolve_readable)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def fmt(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    w: str | None = None,
    g: str | None = None,
    c: bool = False,
    p: str | None = None,
    s: bool = False,
    t: bool = False,
    u: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["fmt"])
    goal_value = g or fl.as_str("goal")
    paths, err = await resolve_readable(ops, accessor, paths, index, "fmt")
    if err and not paths:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await
        generic_fmt(paths,
                    read_bytes=bound_op(ops.read_bytes, accessor, index),
                    stdin=stdin,
                    width=int(w or fl.as_str("width") or "75"),
                    goal=int(goal_value) if goal_value is not None else None,
                    prefix=p or fl.as_str("prefix"),
                    split_only=s or fl.as_bool("split_only"),
                    tagged=t or fl.as_bool("tagged_paragraph"),
                    crown=c or fl.as_bool("crown_margin"),
                    uniform=u or fl.as_bool("uniform_spacing")), err)


BUILDER = Builder('fmt', fmt, None, False, None, read=True)
