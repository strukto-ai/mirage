from pydantic import BaseModel

from mirage import CLI, CLIHandler, CLIInvocation
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io import IOResult


class TallyConfig(BaseModel):
    unit: str


async def total(inv: CLIInvocation[TallyConfig]) -> tuple[bytes, IOResult]:
    values = [int(text) for text in inv.texts]
    line = f"total {sum(values)} {inv.config.unit}\n"
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
