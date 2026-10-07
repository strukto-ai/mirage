import pytest

from mirage.shell.parse import scope
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.parse.types import SourceSpan, SyntaxDiagnostic
from mirage.workspace.workspace.workspace import Workspace


@pytest.mark.asyncio
async def test_owned_diagnostics_admit_execution(monkeypatch):
    parse = scope.parse_program
    programs = []
    diagnostic = SyntaxDiagnostic(
        "injected", SourceSpan(0, 1), "owned refusal\n"
    )

    def diagnosed(source, *args):
        program = parse(source, *args)
        programs.append(program)
        return program

    monkeypatch.setattr(
        ParsedProgram, "diagnostics", property(lambda self: (diagnostic,))
    )
    monkeypatch.setattr(scope, "parse_program", diagnosed)
    ws = Workspace({})
    try:
        result = await ws.shell("echo must-not-run")
        assert (
            result.exit_code,
            await result.stdout_str(),
            await result.stderr_str(),
        ) == (
            2,
            "",
            "owned refusal\n",
        )
        assert all(program.references == 0 for program in programs)
    finally:
        await ws.close()
