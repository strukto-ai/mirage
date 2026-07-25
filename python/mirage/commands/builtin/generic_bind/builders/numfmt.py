from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.numfmt import numfmt as generic_numfmt
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def numfmt(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["numfmt"])
    return await generic_numfmt(
        *texts,
        stdin=stdin,
        to_mode=fl.as_str("to") or "none",
        from_mode=fl.as_str("from") or "none",
        suffix=fl.as_str("suffix") or "",
        grouping=fl.as_bool("grouping"),
    )


BUILDER = Builder("numfmt", numfmt)
