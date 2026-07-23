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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.od import parse_count
from mirage.commands.builtin.generic.split import split as generic_split
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def split(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    args_l: str | None = None,
    b: str | None = None,
    n: str | None = None,
    d: bool = False,
    x: bool = False,
    a: str | None = None,
    t: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["split"])
    paths = await resolve_or_empty(ops, accessor, paths, index)
    lines_value = args_l or fl.as_str("lines")
    bytes_value = b or fl.as_str("bytes")
    number_value = n or fl.as_str("number")
    numeric_value = fl.raw("numeric_suffixes")
    hex_value = fl.raw("hex_suffixes")
    return await generic_split(
        paths,
        read_stream=bound_op(ops.read_stream, accessor, index),
        write_bytes=partial(ops.require(Operation.WRITE), accessor),
        stdin=stdin,
        lines_per_file=int(lines_value) if lines_value else 0,
        byte_limit=parse_count(bytes_value) if bytes_value else 0,
        n_chunks=int(number_value.split("/")[-1]) if number_value else 0,
        suffix_len=int(a or fl.as_str("suffix_length") or "2"),
        numeric_suffix=d or numeric_value is not None,
        hex_suffix=x or hex_value is not None,
        suffix_start=int(numeric_value) if isinstance(numeric_value, str) else
        int(hex_value) if isinstance(hex_value, str) else 0,
        additional_suffix=fl.as_str("additional_suffix") or "",
        separator=(t or fl.as_str("separator") or "\n").encode())


BUILDER = Builder('split',
                  split,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
