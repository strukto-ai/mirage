import sys

import pytest

from mirage.shell.helpers import get_function_body
from mirage.shell.parse.parse import parse_program
from mirage.shell.parse.program import retain_programs


def test_invocation_retains_its_parsed_program():
    program = parse_program("f() { echo hello; } 2>/dev/null")
    body = get_function_body(program.root.named_children[0])
    invoke = retain_programs(body)
    program.release()
    assert b"echo hello" in body[0].text
    assert program.references == 1
    invoke()
    invoke()
    assert program.references == 0
    with pytest.raises(RuntimeError, match="released"):
        _ = body[0].children[0].text


def test_a_program_is_diagnosed_once_when_first_read(monkeypatch):
    module = sys.modules[parse_program.__module__]
    original = module.diagnose
    calls = []

    def counted(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(module, "diagnose", counted)
    program = parse_program("echo $(echo a |)")
    try:
        assert calls == []
        assert len(program.diagnostics) == 1
        assert program.diagnostics is program.diagnostics
        assert len(calls) == 1
    finally:
        program.release()
    with pytest.raises(RuntimeError, match="released"):
        _ = program.diagnostics
