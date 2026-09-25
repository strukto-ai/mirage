import pytest

from mirage.shell.parse import find_syntax_error, parse


@pytest.mark.parametrize("source", [
    "echo ${x:$offset:2}",
    "if false; then echo ${x:.2f}; fi",
    "echo ${x:$(echo 1):${n:-2}}",
])
def test_balanced_substring_defers_arithmetic_to_execution(source):
    root = parse(source)
    assert find_syntax_error(root) is None
    assert root.text.decode() == source


def test_substring_keeps_nested_nodes_and_source_offsets():
    source = "echo é ${x:$(echo 1):$n}"
    expansion = parse(source).named_children[0].named_children[-1]
    stack = [expansion]
    kinds = []
    while stack:
        node = stack.pop()
        assert node.text == source.encode()[node.start_byte:node.end_byte]
        kinds.append(node.type)
        stack.extend(node.children)
    assert "command_substitution" in kinds
    assert "simple_expansion" in kinds


@pytest.mark.parametrize("source", ["echo ${x:$n", "echo ${x:$(echo 1)}; if"])
def test_unbalanced_shell_still_fails(source):
    assert find_syntax_error(parse(source)) is not None
