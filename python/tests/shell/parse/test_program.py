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


def test_diagnostics_name_original_utf8_bytes_after_recovery():
    line = "echo é💡; value=x 2>/dev/null; fi"
    program = parse_program(line)
    try:
        diagnostic = program.diagnostics[0]
        assert diagnostic.offending == "fi"
        span = diagnostic.span
        assert line.encode()[span.start : span.end] == b"fi"
        assert program.root.text == line.encode()
    finally:
        program.release()


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
