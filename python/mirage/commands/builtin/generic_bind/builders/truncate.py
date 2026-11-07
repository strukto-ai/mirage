from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.truncate import parse_flags
from mirage.commands.builtin.generic.truncate import (
    truncate_generic as generic_truncate,
)
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import links_of
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec


async def truncate(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    flags = parse_flags(ctx.flags)
    if isinstance(flags, IOResult):
        return None, flags
    files = command_files(ctx, paths)
    truncate_fn = files.truncate
    paths = await files.resolve_glob(paths)
    links = links_of(ctx)

    async def followed(path: PathSpec) -> FileStat:
        if links is not None:
            path = PathSpec.from_str_path(links.resolve(path.virtual))
        return await files.stat(path)

    return await generic_truncate(
        paths,
        flags=flags,
        stat=files.stat,
        truncate_fn=truncate_fn,
        reference_stat=followed,
    )


BUILDER = GenericCommand("truncate", truncate, write=True)
