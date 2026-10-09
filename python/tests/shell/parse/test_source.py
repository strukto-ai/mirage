import pytest

from mirage.shell import parse
from mirage.shell.parse import join_continuations, source_offsets


@pytest.mark.parametrize(
    "command,expected",
    [
        # An odd-length trailing run ends in a live continuation.
        ("echo a\\", "echo a"),
        ("echo a\\\\\\", "echo a\\\\"),
        ("echo \\", "echo "),
        # An even-length run is all escaped backslashes, so nothing goes.
        ("echo a\\\\", "echo a\\\\"),
        ("echo a\\\\\\\\", "echo a\\\\\\\\"),
        ("echo a", "echo a"),
        ("echo a\\ b", "echo a\\ b"),
        # Mid-line, the pair goes wherever the reader sees it.
        ("echo a\\\nb", "echo ab"),
        ('echo "a\\\nb"', 'echo "ab"'),
        ("echo $\\\n{x} $((1\\\n+2))", "echo ${x} $((1+2))"),
        ("ec\\\nho a", "echo a"),
        ("echo a\\\\\nb", "echo a\\\\\nb"),
        ("echo a\\\\\\\nb", "echo a\\\\b"),
        # Single-quoted and ANSI-C text and comments keep theirs.
        ("echo 'a\\\nb'", "echo 'a\\\nb'"),
        ("echo $'a\\\nb'", "echo $'a\\\nb'"),
        ("echo a # c \\\necho b", "echo a # c \\\necho b"),
        ("echo \"$(echo 'u\\\nv')\"", "echo \"$(echo 'u\\\nv')\""),
        ('echo "it\'s a\\\nb"', 'echo "it\'s ab"'),
    ],
)
def test_join_continuations(command, expected):
    assert join_continuations(command) == expected


def test_quoted_heredoc_body_keeps_its_continuations():
    root = parse("cat <<'E' | \\\ntr a b\na\\\nb\nE")
    assert root.text == b'cat <"a\\\\\nb\n" | tr a b\n'
    assert root.source_text == b"cat <<'E' | \\\ntr a b\na\\\nb\nE"


def test_unquoted_heredoc_body_joins_its_lines():
    root = parse("cat <<E | \\\ntr a b\na\\\nb $x\nE")
    assert root.text == b'cat <"ab $x\n" | tr a b\n'


@pytest.mark.parametrize(
    "command",
    [
        "echo A; \\\n fi",
        "echo /api/$c/$id.json; fi",
        "! echo A \\\n; fi",
        "time echo A \\\n; fi",
        "cat <<E; fi\nbody\nE",
    ],
    ids=["continuation", "rebrace", "bang", "time", "heredoc"],
)
def test_source_offsets_point_back_into_the_line_as_typed(command):
    root = parse(command)
    stack, names = [root], []
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type == "command_name" and node.text == b"fi":
            names.append(node)
    (fi,) = names
    offsets = source_offsets(command, root)
    assert offsets[fi.start_byte] == command.encode().rindex(b"fi")


def test_extended_pattern_shield_preserves_original_rows():
    root = parse("echo @(😀\nb|c)\necho after")
    first, second = root.named_children
    assert first.text == "echo @(😀\nb|c)".encode()
    assert first.end_point == (1, 4)
    assert second.start_point == (2, 0)
    assert second.text == b"echo after"
