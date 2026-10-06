import gc

from mirage.shell.helpers import get_function_body
from mirage.shell.parse.parse import parse_program
from mirage.workspace.session.functions import FunctionTable


def _defined(source: str):
    program = parse_program(source)
    return program, get_function_body(program.root.named_children[0])


def test_a_stored_body_leases_its_program_once():
    program, body = _defined("f() { echo a; echo b; }")
    functions = FunctionTable({"f": body})
    assert program.references == 2
    functions["g"] = body
    assert program.references == 3
    functions.clear()
    assert program.references == 1


def test_replacing_or_deleting_a_name_releases_its_lease():
    first, old = _defined("f() { echo old; }")
    second, new = _defined("f() { echo new; }")
    functions = FunctionTable({"f": old})
    functions["f"] = new
    assert (first.references, second.references) == (1, 2)
    del functions["f"]
    assert second.references == 1
    assert "f" not in functions


def test_a_dropped_table_releases_its_leases():
    program, body = _defined("f() { echo a; }")
    functions = FunctionTable({"f": body})
    assert program.references == 2
    del functions
    gc.collect()
    assert program.references == 1
