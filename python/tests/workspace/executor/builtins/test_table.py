import inspect

from mirage.shell.types import ShellBuiltin
from mirage.workspace.executor.builtins.table import BUILTINS
from mirage.workspace.lookup.constants import JOB_BUILTINS

# Interpreters are general mount commands (commands/builtin/general),
# reserved in ShellBuiltin only so no CLI can take the name.
INTERPRETERS = frozenset({"python", "python3", "node", "js"})


def test_table_covers_every_executor_builtin():
    expected = {str(b) for b in ShellBuiltin} - JOB_BUILTINS - INTERPRETERS
    assert set(BUILTINS) == expected


def test_aliases_share_a_handler():
    assert BUILTINS["."] is BUILTINS["source"]
    assert BUILTINS["sh"] is BUILTINS["bash"]
    assert BUILTINS["readarray"] is BUILTINS["mapfile"]
    assert BUILTINS["typeset"] is BUILTINS["declare"]
    assert BUILTINS["readonly"] is BUILTINS["declare"]
    assert BUILTINS["["] is BUILTINS["test"] is BUILTINS["[["]


def test_every_entry_is_a_coroutine_function():
    for name, fn in BUILTINS.items():
        assert inspect.iscoroutinefunction(fn), name
