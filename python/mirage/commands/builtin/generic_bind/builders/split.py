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
from mirage.commands.builtin.generic.split import (parse_bytes_value,
                                                   parse_chunks_value,
                                                   parse_lines_value,
                                                   parse_suffix_length,
                                                   parse_suffix_start)
from mirage.commands.builtin.generic.split import split as generic_split
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def split(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["split"])
    paths = await resolve_or_empty(ops, accessor, paths, index)
    # as_str, not `x or y`: the latter would swallow an explicitly empty
    # value, which GNU rejects loudly (`split -b ''` is an invalid number,
    # not an absent flag).
    lines_value = fl.as_str("lines")
    bytes_value = fl.as_str("bytes")
    number_value = fl.as_str("number")
    numeric_value = fl.raw("numeric_suffixes")
    hex_value = fl.raw("hex_suffixes")
    length_value = fl.as_str("suffix_length")
    # GNU reads an explicit `-a 0` as "revert to auto width": names start
    # at the default length of 2 and keep auto-lengthening. An explicit
    # width or an explicit start value pins the width instead.
    suffix_len_raw = (parse_suffix_length(length_value)
                      if length_value is not None else None)
    suffix_len = suffix_len_raw or 2
    suffix_auto = (not suffix_len_raw and not isinstance(numeric_value, str)
                   and not isinstance(hex_value, str))
    suffix_start = (parse_suffix_start(numeric_value, False, suffix_len)
                    if isinstance(numeric_value, str) else
                    parse_suffix_start(hex_value, True, suffix_len)
                    if isinstance(hex_value, str) else 0)
    return await generic_split(
        paths,
        read_stream=bound_op(ops.read_stream, accessor, index),
        write_bytes=partial(ops.require(Operation.WRITE), accessor),
        stdin=stdin,
        lines_per_file=(parse_lines_value(lines_value)
                        if lines_value is not None else 0),
        byte_limit=(parse_bytes_value(bytes_value)
                    if bytes_value is not None else 0),
        n_chunks=(parse_chunks_value(number_value)
                  if number_value is not None else 0),
        suffix_len=suffix_len,
        suffix_auto=suffix_auto,
        numeric_suffix=numeric_value is not None,
        hex_suffix=hex_value is not None,
        suffix_start=suffix_start,
        additional_suffix=fl.as_str("additional_suffix") or "",
        separator=(fl.as_str("separator") or "\n").encode())


BUILDER = Builder('split',
                  split,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
