import inspect

from mirage import RAMVFS, Workspace
from mirage.server.vfs_calls import VFS_CALLS
from mirage.workspace.workspace import Session


def test_each_call_is_a_method_taking_its_arguments_by_name():
    session = Session(Workspace({"/": RAMVFS()}), None)
    for call in VFS_CALLS:
        wire = {name.removesuffix("_base64") for name in call.params}
        for target in (session.vfs, session.explain.vfs):
            taken = inspect.signature(getattr(target, call.name)).parameters
            assert wire <= set(taken), (call.name, type(target).__name__)
