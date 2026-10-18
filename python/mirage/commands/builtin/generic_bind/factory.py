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

import functools
from collections.abc import AsyncIterator, Callable
from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.builtin.generic_bind.files import Reading, with_reading
from mirage.commands.config import (
    Command,
    CommandCatalog,
    CommandFnResult,
    Context,
    command,
    registered_commands,
)
from mirage.commands.spec import SPECS
from mirage.io.cooperative import chunks
from mirage.io.types import IOResult
from mirage.types import PathSpec


async def _run_builder(
    builder: GenericCommand,
    reading: Reading,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> CommandFnResult:
    """Run a builder on the mount it runs on, its files read as
    ``reading`` says.

    A run with no files has no workspace to reach and is refused. Every
    call the builder makes through its files is the dispatcher's, which
    judges each itself.

    Args:
        builder (GenericCommand): the builder.
        reading (Reading): how its files read.
        accessor (Accessor): the mount's accessor.
        paths (list[PathSpec]): the command's path operands.
        texts (list[str]): the command's text arguments.
        ctx (Context): the per-invocation option bag.
    """
    if ctx.vfs is None:
        return None, IOResult(
            exit_code=1,
            stderr=f"{builder.name}: no workspace files\n".encode(),
        )
    if reading.split and ctx.stdin is not None:
        # A RAM or cache read arrives as one whole chunk, over which a
        # scan that splits its buffer per line is quadratic and cannot be
        # cancelled until it ends; stdin is cut into pieces with a yield
        # between them, as each operand read is and as TypeScript's
        # guardInput. A pass-through builder (cat, head) keeps the
        # producer's chunks: it writes a pipe in the writes the producer
        # made, so a write the reader's close cuts short is its SIGPIPE,
        # and a scan inside it splits its own input.
        ctx = replace(ctx, stdin=chunks(ctx.stdin))
    with with_reading(ctx, reading) as run:
        return await builder.fn(accessor, paths, texts, run)


_BY_NAME = {b.name: b for b in BUILDERS}


def _bind(
    builder: GenericCommand,
    vfs: str | None,
    stream: Callable[[Context, PathSpec], AsyncIterator[bytes] | None] | None,
) -> Command:
    # The builder reads its files under the command tier's guards: what it
    # reads, cut into pieces unless it passes its input through, and a
    # stat's unknown size filled from the read cache unless it only
    # writes.
    reading = Reading(
        split=not builder.pass_through,
        cached_sizes=not builder.write or builder.read,
        stream=stream,
    )
    bound = functools.partial(_run_builder, builder, reading)
    (registered,) = registered_commands(
        [
            command(
                builder.name,
                vfs=vfs,
                spec=SPECS[builder.name],
                aggregate=builder.aggregate,
                write=builder.write,
            )(bound)
        ]
    )
    return registered


# Every mount falls back to these after its VFS's own commands. Each reads
# and writes through the files of the command it runs (``ctx.vfs``), so one
# set serves the whole workspace.
GENERIC_COMMANDS = CommandCatalog(_bind(b, None, None) for b in BUILDERS)


def generic_reading(
    name: str,
    *,
    vfs: str | None = None,
    stream: (
        Callable[[Context, PathSpec], AsyncIterator[bytes] | None] | None
    ) = None,
) -> Command:
    """The generic command ``name`` registered for ``vfs``, each operand
    streamed by ``stream`` where it answers one (None keeps the
    dispatched read): ``/dev``'s endless ``cat`` and ``head``.

    Args:
        name (str): the command name.
        vfs (str | None): the backend it registers under.
        stream (Callable | None): what streams an operand, given the
            invocation's context and the path; an answer of None keeps
            the dispatched read.

    Raises:
        ValueError: no generic command has that name.
    """
    builder = _BY_NAME.get(name)
    if builder is None:
        raise ValueError(f"no generic command named {name!r}")
    if vfs is None and stream is None:
        return GENERIC_COMMANDS.require(name)
    return _bind(builder, vfs, stream)


def generic(name: str, *, vfs: str | None = None) -> Command:
    """The default command ``name``, which a mount runs when its VFS has
    no command of that name.

    A VFS that replaces a command hands what the replacement does not
    support to this one: ``generic("grep").fn(accessor, paths, texts,
    ctx)``. With ``vfs``, the same command registered for that backend.

    Args:
        name (str): the command name.
        vfs (str | None): the backend a copy registers under.

    Raises:
        ValueError: no generic command has that name.
    """
    return generic_reading(name, vfs=vfs)
