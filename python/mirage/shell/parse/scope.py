from mirage.shell.parse.parse import parse_program
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.types import TSNodeLike


class ParseScope:
    """The parses one line or one substitution makes, released together.

    A cancelled line is joined before its caller hears back, so the scope
    outlives every tree walking it; TypeScript, which answers the caller
    first, keeps a ``retain`` for that.
    """

    def __init__(self) -> None:
        self._programs: list[ParsedProgram] = []
        self._released = False

    def parse(self, command: str) -> TSNodeLike:
        if self._released:
            raise RuntimeError("parse scope is released")
        program = parse_program(command)
        self._programs.append(program)
        return program.root

    def release(self) -> None:
        if not self._released:
            self._released = True
            for program in self._programs:
                program.release()
            self._programs.clear()
