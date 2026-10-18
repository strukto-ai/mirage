from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.truncate import parse_flags
from mirage.commands.builtin.generic.truncate import (
    truncate_generic as generic_truncate,
)
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def truncate(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    flags = parse_flags(ctx.flags)
    truncate_fn = files.truncate
    paths = await files.resolve_glob(paths)
    return await generic_truncate(
        paths,
        flags=flags,
        stat=files.stat,
        truncate_fn=truncate_fn,
    )


BUILDER = GenericCommand("truncate", truncate, write=True)
