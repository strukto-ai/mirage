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
