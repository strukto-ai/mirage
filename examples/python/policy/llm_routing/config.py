from typing import Literal

from pydantic import BaseModel


class MachineChoice(BaseModel):
    machine: Literal["monty", "local"]
    reason: str
