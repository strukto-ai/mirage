from pydantic import BaseModel

from mirage import CLIInvocation, CLISpec
from mirage.commands.spec.types import Operand
from mirage.io import IOResult


class TallyConfig(BaseModel):
    unit: str


async def total(inv: CLIInvocation[TallyConfig]) -> tuple[bytes, IOResult]:
    values = [int(text) for text in inv.texts]
    line = f"total {sum(values)} {inv.config.unit}\n"
    return line.encode(), IOResult()


TALLY = CLISpec(name="tally",
                description="Add numbers in a unit",
                config_model=TallyConfig,
                subcommands=(CLISpec(name="sum",
                                     description="Sum the operands",
                                     fn=total,
                                     rest=Operand(type="str")), ))
