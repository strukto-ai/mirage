from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from mirage.io.types import ByteSource

PairOutcome = Literal["equal", "different"]
InputFactory = Callable[[], Awaitable[ByteSource]]


@dataclass(frozen=True, slots=True)
class DiffOptions:
    mode: Literal["normal", "unified", "ed"] = "normal"
    context: int = 3
    ignore_case: bool = False
    ignore_all_space: bool = False
    ignore_space_change: bool = False
    text: bool = False
    brief: bool = False
    old_label: str = "a"
    new_label: str = "b"
    old_header: str = ""
    new_header: str = ""


@dataclass(frozen=True, slots=True)
class PairResult:
    outcome: PairOutcome
    output: tuple[bytes, ...]
    status: Literal[0, 1, 2]
    stderr: tuple[bytes, ...]


class DiffComputer(Protocol):
    async def compare(
        self, options: DiffOptions, old: InputFactory, new: InputFactory
    ) -> PairResult: ...
