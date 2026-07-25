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
from mirage.commands.builtin.generic.nl import nl as generic_nl
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import (
    merge_split_errors, resolve_readable)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def nl(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    b: str | None = None,
    v: str | None = None,
    i: str | None = None,
    w: str | None = None,
    s: str | None = None,
    f: str | None = None,
    h: str | None = None,
    args_l: str | None = None,
    n: str | None = None,
    p: bool = False,
    d: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["nl"])
    paths, err = await resolve_readable(ops, accessor, paths, index, "nl")
    if err and not paths:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await generic_nl(
            paths,
            read_stream=bound_op(ops.read_stream, accessor, index),
            stdin=stdin,
            body_numbering_raw=b or fl.as_str("body_numbering"),
            start_raw=v or fl.as_str("starting_line_number"),
            increment_raw=i or fl.as_str("line_increment"),
            width_raw=w or fl.as_str("number_width"),
            separator=s or fl.as_str("number_separator"),
            footer_numbering_raw=f or fl.as_str("footer_numbering"),
            header_numbering_raw=h or fl.as_str("header_numbering"),
            join_blank_lines_raw=args_l or fl.as_str("join_blank_lines"),
            number_format=n or fl.as_str("number_format") or "rn",
            delimiter=d or fl.as_str("section_delimiter") or "\\:",
            no_renumber=p or fl.as_bool("no_renumber"),
        ), err)


BUILDER = Builder('nl', nl, None, False, None, read=True)
