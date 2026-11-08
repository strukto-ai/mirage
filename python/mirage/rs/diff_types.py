from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from mirage.io.types import ByteSource

PairOutcome = Literal["equal", "different"]
InputFactory = Callable[[], Awaitable[ByteSource]]


DiffMode = Literal["normal", "unified", "ed", "context", "rcs", "sides"]


@dataclass(frozen=True, slots=True)
class DiffOptions:
    """One pair's comparison and output, as the diff engine reads them;
    each pattern and width is spelled one character per byte."""

    mode: DiffMode = "normal"
    context: int = 3
    ignore_case: bool = False
    ignore_all_space: bool = False
    ignore_space_change: bool = False
    ignore_tab_expansion: bool = False
    ignore_trailing_space: bool = False
    strip_trailing_cr: bool = False
    ignore_blank_lines: bool = False
    ignore_lines: tuple[str, ...] = ()
    function_lines: tuple[str, ...] = ()
    show_c_function: bool = False
    expand_tabs: bool = False
    initial_tab: bool = False
    widths: tuple[str, ...] = ()
    suppress_common: bool = False
    left_column: bool = False
    text: bool = False
    brief: bool = False
    utf8: bool = False
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
