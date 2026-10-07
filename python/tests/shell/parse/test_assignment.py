import pytest

from mirage.shell.parse.parse import parse_program


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
