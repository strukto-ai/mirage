from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.numfmt import (
    numfmt_generic as generic_numfmt,
)
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def numfmt(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["numfmt"])
    return await generic_numfmt(
        *texts,
        stdin=ctx.stdin,
        to_mode=fl.as_str("to") or "none",
        from_mode=fl.as_str("from") or "none",
        suffix=fl.as_str("suffix") or "",
        grouping=fl.as_bool("grouping"),
        fields=[str(value) for _, value in fl.occurrences("field")],
        delimiters=[str(value) for _, value in fl.occurrences("delimiter")],
        headers=[
            "1" if value is True else str(value)
            for _, value in fl.occurrences("header")
        ],
        zero_terminated=fl.as_bool("zero_terminated"),
    )


BUILDER = GenericCommand("numfmt", numfmt)
