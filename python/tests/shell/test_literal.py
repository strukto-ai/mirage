import pytest

from mirage.shell.literal import literal_tree


def test_literal_tree_is_one_command_of_quoted_words():
    tree = literal_tree(("printf", "%s", "$(whoami)"))
    command = tree.children[0]
    assert (tree.type, command.type) == ("program", "command")
    assert tree.text == b"printf %s '$(whoami)'"
    assert [c.type for c in command.children
            ] == ["command_name", "raw_string", "raw_string"]
    assert command.children[0].text == b"printf"
    assert [c.text for c in command.children[1:]] == [b"'%s'", b"'$(whoami)'"]
    assert all(c.parent is command for c in command.children)
    assert command.child_by_field_name("name") is command.children[0]


@pytest.mark.parametrize("argv", [(), ("", ), ("echo", "a\0b")])
def test_literal_tree_refuses_argv_naming_no_program_or_holding_nul(argv):
    with pytest.raises(ValueError):
        literal_tree(argv)
