from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.od import od_generic as generic_od
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    resolve_or_empty,
)
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def od(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    paths = await resolve_or_empty(files, paths)
    return await generic_od(
        paths,
        ctx,
        read_stream=files.read_stream,
    )


BUILDER = GenericCommand("od", od, read=True)
