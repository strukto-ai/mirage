import gc
import weakref

import pytest

from mirage.shell.bytes import encode_text
from mirage.shell.helpers import get_function_body
from mirage.shell.parse.parse import parse_program
from mirage.shell.parse.program import retain_programs, shell_node


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


def test_release_drops_heavy_state_before_collection():
    program = parse_program("echo '" + "x" * 1048576 + "'")
    root = program.root
    child = root.named_children[0]
    sibling = child.children[0].parent
    assert isinstance(program.offsets, range)
    assert program.offsets[-1] == 1048583
    hold = program.retain()
    program.release()
    program.release()
    assert child.text.startswith(b"echo")
    hold()
    hold()
    assert program.references == 0
    assert not program.original and not program.offsets
    for node in (root, child, sibling):
        assert node._borrowed is None
        with pytest.raises(RuntimeError, match="released"):
            _ = node.text
    with pytest.raises(RuntimeError, match="released"):
        program.retain()
    with pytest.raises(RuntimeError, match="released"):
        shell_node(root)


def test_release_breaks_root_cycle_without_gc():
    gc.collect()
    program = parse_program("echo hello")
    ref = weakref.ref(program)
    program.release()
    del program
    assert ref() is None


@pytest.mark.parametrize(
    "text",
    [
        "echo é😀",
        "echo \udcff",
        "ec\\\nho é😀",
        "cat <<E\né😀\nE\n",
        "cat <<'E'\n$HOME\nE\n",
    ],
)
def test_compact_offsets_keep_byte_coordinates(text):
    program = parse_program(text)
    offsets = program.offsets
    assert offsets[-1] == len(encode_text(text))
    assert program.root.source_text == encode_text(text)
    program.release()
