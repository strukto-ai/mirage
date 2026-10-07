from collections.abc import Mapping

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
        return self.program(command).root

    def program(
        self,
        command: str,
        aliases: frozenset[str] = frozenset(),
        own: Mapping[str, tuple[int, int]] | None = None,
    ) -> ParsedProgram:
        """Parse source with its alias grammar, retaining the owned result.

        Args:
            command (str): source as supplied by the caller.
            aliases (frozenset[str]): names eligible for alias expansion.
            own (Mapping[str, tuple[int, int]] | None): alias source spans.
        """
        if self._released:
            raise RuntimeError("parse scope is released")
        program = parse_program(command, aliases, own)
        self._programs.append(program)
        return program

    def release(self) -> None:
        if not self._released:
            self._released = True
            for program in self._programs:
                program.release()
            self._programs.clear()
