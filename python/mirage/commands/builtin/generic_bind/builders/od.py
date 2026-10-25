from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView, spec_flag_names
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def od(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    # mirage-rs reads every option in the order typed, each value as
    # typed, and the operands, which an offset or a label may end.
    fl = FlagView(ctx.flags, spec=SPECS["od"])
    config: dict[str, JsonValue] = {
        "options": [
            [name, value if isinstance(value, bool) else byte_view(str(value))]
            for name, value in fl.occurrences(*spec_flag_names(SPECS["od"]))
        ],
        "operands": [byte_view(path.raw_path) for path in resolved],
    }
    host = StreamHost(
        resolved,
        normalized_read(files.read),
        ctx.stdin,
        None,
        ctx.cwd,
        command="od",
    )
    io = IOResult()
    return hosted_stream("od", config, host, io), io


BUILDER = GenericCommand("od", od, read=True)
