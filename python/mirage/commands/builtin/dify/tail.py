from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail", resource="dify", spec=SPECS["tail"])
async def tail(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    n: int | str = 10,
    args_n: int | str | None = None,
    c: int | str | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = _extra.get("index")
    limit = int(args_n if args_n is not None else n)
    bytes_limit = int(c) if c is not None else None
    paths = await resolve_glob(accessor, paths, index)
    return generic_tail(read_stream(accessor, paths[0], index),
                        n=limit,
                        c=bytes_limit), IOResult()
