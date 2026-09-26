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

import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic.rg import folds_case
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import CommandIO, bound_op
from mirage.commands.builtin.grep_pattern import PATTERN_KEYS, pattern_arg
from mirage.commands.builtin.grep_pushdown import (grep_search_meta,
                                                   literal_pushdown_operand,
                                                   pushdown_operand,
                                                   text_search_results)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.context import hidden_paths_intersect, path_rules_active
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec
from mirage.utils.errors import FileTooLargeError
from mirage.vfs.types import SearchQuery

logger = logging.getLogger(__name__)

_GENERICS = {"grep": generic_grep, "rg": generic_rg}


def search_options(name: str, fl: FlagView,
                   pattern: str) -> dict[str, JsonValue]:
    """How a native search matches the pushed-down pattern.

    Args:
        name (str): grep or rg.
        fl (FlagView): the invocation's flags.
        pattern (str): the pattern pushed down.
    """
    if name == "rg":
        f = parse_rg_flags(fl)
        return {
            "ignore_case": folds_case(pattern, f.fixed_string, f),
            "fixed_string": f.fixed_string,
            "whole_word": f.whole_word,
            "basic": False,
        }
    return {
        "ignore_case": fl.as_bool("i"),
        "fixed_string": fl.as_bool("F"),
        "whole_word": fl.as_bool("w"),
        "basic": not fl.as_bool("E"),
    }


def native_or_bytes(
    read_stream: Callable[[PathSpec], AsyncIterator[bytes]],
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """A stream that falls back to the whole read on a first-pull failure.

    A native stream may serve only some kinds (mongodb streams
    documents.jsonl and refuses schema.json before yielding anything), so
    a failure before any data has flowed falls back to ``read_bytes``; an
    error after data has flowed is real and propagates. Mirrors the TS
    ``nativeOrBytes`` in ``generic_bind/search.ts``.

    Args:
        read_stream (Callable[[PathSpec], AsyncIterator[bytes]]): the
            bound native stream op.
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): the bound
            whole-read op the first pull falls back to.
    """

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        it = read_stream(path).__aiter__()
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            return
        except OSError:
            yield await read_bytes(path)
            return
        yield first
        async for chunk in it:
            yield chunk

    return stream


async def run_search(
    io: CommandIO,
    name: str,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """Run the adapter's native search, or scan for an unsupported request.

    Args:
        io (CommandIO): guarded resource operations and optional search.
        name (str): grep or rg.
        accessor (Accessor): resource handle.
        paths (list[PathSpec]): operands.
        texts (list[str]): pattern arguments.
        opts (CommandOpts): parsed invocation context.
    """
    capability = io.search
    meta = grep_search_meta(capability)
    generic = _GENERICS[name]
    fl = FlagView(opts.flags, spec=SPECS[name])
    pattern = pattern_arg(texts, fl, PATTERN_KEYS[name])
    gate = (literal_pushdown_operand if meta is not None
            and meta.mode == "literal" else pushdown_operand)
    operand = gate(paths, opts.flags, pattern)
    if (capability is not None and meta is not None and pattern is not None
            and operand is not None
            and not hidden_paths_intersect(operand.virtual)
            and not path_rules_active()):
        query = SearchQuery(
            query=pattern, options={"grep": search_options(name, fl, pattern)})
        try:
            lines = await capability.search(accessor, operand, query,
                                            opts.index)
        except FileTooLargeError as exc:
            # A push-down whose answer is past the mount's read cap cannot
            # print it; the scan reads each operand, and reports the same
            # refusal against the operand as typed.
            logger.debug("%s push-down refused %s: %s", name, operand.virtual,
                         exc)
            lines = None
        if lines is not None:
            if not lines:
                return b"", IOResult(exit_code=1)
            if name != "grep" or text_search_results(lines):
                return format_records(lines), IOResult()

    resolved = await io.resolve_glob(accessor, paths,
                                     index=opts.index) if paths else []
    stream = meta is None or meta.stream
    return await generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(io.readdir, accessor, opts.index),
        stat=bound_op(io.stat, accessor, opts.index),
        read_bytes=bound_op(io.read_bytes, accessor, opts.index),
        read_stream=native_or_bytes(
            bound_op(io.read_stream, accessor, opts.index),
            bound_op(io.read_bytes, accessor, opts.index)) if stream else None,
        stdin=opts.stdin,
    )
