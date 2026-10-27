from typing import Literal

from pydantic import BaseModel


class RuntimeChoice(BaseModel):
    runtime: Literal["monty", "local"]
    reason: str
