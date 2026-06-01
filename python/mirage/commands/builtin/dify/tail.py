from mirage.commands.builtin.generic.tail import tail_multi
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
    return tail_multi(paths,
                      read=read_stream,
                      accessor=accessor,
                      index=index,
                      n=limit,
                      c=bytes_limit,
                      show_headers=len(paths) > 1), IOResult()
