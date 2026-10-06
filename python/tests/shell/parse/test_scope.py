import pytest

from mirage.shell.parse.scope import ParseScope


def test_a_released_scope_releases_every_program_it_parsed():
    scope = ParseScope()
    roots = [
        scope.parse(line)
        for line in (
            "echo hi",
            "((echo inner); echo outer)",
            "cat <<E\nhi\nE",
            'v=$(echo x) 2>/dev/null; echo "$v"',
        )
    ]
    scope.release()
    assert [root.program.references for root in roots] == [0, 0, 0, 0]
    with pytest.raises(RuntimeError, match="released"):
        scope.parse("echo")
