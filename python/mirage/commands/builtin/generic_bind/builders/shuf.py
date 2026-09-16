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
from mirage.commands.builtin.generic.shuf import NO_WRITE_OP, parse_flags
from mirage.commands.builtin.generic.shuf import shuf as generic_shuf
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def shuf(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    """Run shuf over resolved operands; mirrors shufGeneric.

    The refusals are caught here rather than left to the executor's
    catch-all, which is what the TypeScript twin does: `shufGeneric`
    returns an `IOResult` for a bad `-n` or `-i`, so a direct call
    (a unit test, an embedder) got a raised exception on this host and a
    value on that one. The bytes and the exit code are identical either
    way inside a workspace -- `format_fs_error` emits an
    already-prefixed message verbatim -- so this moves nothing a shell
    line can see. `shuf` has no `shuf_generic` wrapper of its own, so
    the builder is where the guard belongs.

    `NO_WRITE_OP` is deliberately NOT caught: that one is a backend
    wired without a write op, which the TypeScript twin throws for too.

    Args:
        ops (CommandIO): the backend's bound op table.
        accessor (Accessor): the backend handle.
        paths (list[PathSpec]): operands, empty for stdin.
        texts (list[str]): non-path words, which `-e` shuffles.
        opts (CommandOpts): flags and stdin from the dispatcher.
    """
    try:
        return await _shuf(ops, accessor, paths, texts, opts)
    except ValueError as exc:
        # Every user-facing refusal becomes an IOResult, but a `-o` on a
        # backend with no write op is a wiring fault and the TypeScript
        # twin throws for it, so it keeps propagating.
        if str(exc) == NO_WRITE_OP:
            raise
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())


async def _shuf(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
                texts: list[str],
                opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    if paths:
        paths = await ops.resolve_glob(accessor, paths, opts.index)
    elif not ops.is_mounted(accessor):
        paths = []
    # Only ``-o`` writes, so a read-only backend still serves plain shuf.
    # Requiring the write op here would break every read-only backend.
    write_op = ops.operation(Operation.WRITE)
    return await generic_shuf(paths,
                              texts,
                              read_bytes=bound_op(ops.read_bytes, accessor,
                                                  opts.index),
                              stdin=opts.stdin,
                              count=parsed.count,
                              echo=parsed.echo,
                              zero_terminated=parsed.zero_terminated,
                              with_replacement=parsed.with_replacement,
                              input_range=parsed.input_range,
                              output=parsed.output,
                              write_bytes=partial(write_op, accessor)
                              if write_op is not None else None)


BUILDER = Builder('shuf', shuf, None, False, None, read=True)
