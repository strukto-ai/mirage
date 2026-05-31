from mirage.commands.builtin.aggregators import wc_aggregate
from mirage.commands.builtin.generic.wc import WCCounts, format_wc
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc", resource="dify", spec=SPECS["wc"], aggregate=wc_aggregate)
async def wc(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = _extra.get("index")
    paths = await resolve_glob(accessor, paths, index)
    reads: dict[str, bytes] = {}
    output: list[str] = []
    totals = WCCounts()
    for path in paths:
        data = await read_bytes(accessor, path, index)
        reads[path.original] = data
        counts = await generic_wc(data)
        totals.merge(counts)
        output.append(
            format_wc(counts,
                      args_l=args_l,
                      w=w,
                      c=c,
                      m=m,
                      L=L,
                      label=path.original))
    if len(paths) > 1:
        output.append(
            format_wc(totals, args_l=args_l, w=w, c=c, m=m, L=L,
                      label="total"))
    return "\n".join(output).encode(), IOResult(reads=reads, cache=list(reads))
