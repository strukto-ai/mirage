import sys

import pytest

from mirage.shell.helpers import get_function_body
from mirage.shell.parse.parse import parse_program
from mirage.shell.parse.program import retain_programs
from mirage.workspace.session.functions import FunctionTable


def test_function_and_invocation_retain_the_defining_program():
    program = parse_program("f() { echo hello; } 2>/dev/null")
    body = get_function_body(program.root.named_children[0])
    functions = FunctionTable({"f": body})
    invoke = retain_programs(body)
    program.release()
    del functions["f"]
    assert b"echo hello" in body[0].text
    assert program.references == 1
    invoke()
    invoke()
    assert program.references == 0
    with pytest.raises(RuntimeError, match="released"):
        _ = body[0].children[0].text


@pytest.mark.parametrize(
    "line",
    [
        "value=x 2>/dev/null; echo done",
        "  value=é💡 2>/dev/null; echo done",
        "value=$(echo x) 2>/dev/null && echo done",
    ],
)
def test_assignment_recovery_keeps_source_and_siblings(line):
    program = parse_program(line)
    try:
        assert not program.diagnostics
        pending = [program.root]
        raw = line.encode()
        while pending:
            node = pending.pop()
            assert node.text == raw[node.start_byte : node.end_byte]
            children = node.children
            for index, child in enumerate(children):
                assert node.child(index).text == child.text
                if index + 1 < len(children):
                    assert child.next_sibling.text == children[index + 1].text
                if index > 0:
                    assert child.prev_sibling.text == children[index - 1].text
            pending.extend(children)
    finally:
        program.release()


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
