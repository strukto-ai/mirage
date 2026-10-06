from collections.abc import Callable

from mirage.shell.parse.parse import parse_program
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.types import TSNodeLike


class ParseScope:
    """A line and its asynchronous jobs own incidental parses together."""

    def __init__(self) -> None:
        self._references = 1
        self._programs: list[ParsedProgram] = []
        self._released = False

    def parse(self, command: str) -> TSNodeLike:
        if self._references == 0:
            raise RuntimeError("parse scope is released")
        program = parse_program(command)
        self._programs.append(program)
        return program.root

    def retain(self) -> Callable[[], None]:
        if self._references == 0:
            raise RuntimeError("parse scope is released")
        self._references += 1
        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self._drop()

        return release

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._drop()

    def _drop(self) -> None:
        self._references -= 1
        if self._references == 0:
            for program in self._programs:
                program.release()
            self._programs.clear()
