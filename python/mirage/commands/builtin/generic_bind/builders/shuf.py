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
from mirage.commands.builtin.generic.shuf import NO_WRITE_OP, parse_flags
from mirage.commands.builtin.generic.shuf import shuf_generic as generic_shuf
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import mount_root
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def shuf(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
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
        accessor (Accessor): the backend handle.
        paths (list[PathSpec]): operands, empty for stdin.
        texts (list[str]): non-path words, which `-e` shuffles.
        ctx (Context): flags and stdin from the dispatcher.
    """
    try:
        return await _shuf(accessor, paths, texts, ctx)
    except ValueError as exc:
        # Every user-facing refusal becomes an IOResult, but a `-o` on a
        # backend with no write op is a wiring fault and the TypeScript
        # twin throws for it, so it keeps propagating.
        if str(exc) == NO_WRITE_OP:
            raise
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())


async def _shuf(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    parsed = parse_flags(ctx.flags)
    if paths:
        paths = await files.resolve_glob(paths)
    return await generic_shuf(
        paths,
        texts,
        read=files.read,
        stdin=ctx.stdin,
        count=parsed.count,
        echo=parsed.echo,
        zero_terminated=parsed.zero_terminated,
        with_replacement=parsed.with_replacement,
        input_range=parsed.input_range,
        output=parsed.output,
        # Only ``-o`` writes, so a read-only backend still serves plain
        # shuf: without a write of its own it is refused at ``-o``.
        write_bytes=(files.write if files.answers("write") else None),
        root=mount_root(ctx),
        ids=ctx.ids,
    )


BUILDER = GenericCommand("shuf", shuf, write=True, read=True)
