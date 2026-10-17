from pydantic import BaseModel

from mirage import CLI, CLIHandler, Context, PathSpec
from mirage.accessor import NOOPAccessor
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io import IOResult


class TallyConfig(BaseModel):
    unit: str


async def total(
    accessor: NOOPAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes, IOResult]:
    values = [int(text) for text in texts]
    line = f"total {sum(values)} {accessor.config.unit}\n"
    return line.encode(), IOResult()


TALLY = CLI(
    spec=CommandSpec(
        name="tally",
        description="Add numbers in a unit",
        subcommands=(CommandSpec(
            name="sum",
            description="Sum the operands",
            arguments=(Argument("values", nargs="*", metavar=""),),
        ),),
    ),
    handlers={"sum": CLIHandler(fn=total)},
    config_model=TallyConfig,
)
