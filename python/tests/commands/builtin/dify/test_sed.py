import pytest

from mirage.commands.builtin.dify import COMMANDS
from mirage.core.dify import read, tree
from mirage.io.types import materialize

from .conftest import document


def _sed_command():
    for cmd in COMMANDS:
        for rc in cmd._registered_commands:
            if rc.name == "sed":
                return cmd
    raise LookupError("sed not registered for dify")


sed = _sed_command()


async def list_documents(config):
    return [document("doc-1", "Guide", "guides/quickstart.md")]


async def get_segments(config, document_id):
    return [{"content": "alpha beta"}]


@pytest.mark.asyncio
async def test_sed_transforms_dify_document(monkeypatch, dify_accessor,
                                            dify_index, guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(read, "get_document_segments", get_segments)

    stdout, io = await sed(dify_accessor, [guide_path],
                           "s/alpha/gamma/",
                           index=dify_index)

    assert await materialize(stdout) == b"gamma beta"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_sed_rejects_in_place(monkeypatch, dify_accessor, dify_index,
                                    guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)

    with pytest.raises(PermissionError,
                       match="-i not supported on this backend"):
        await sed(dify_accessor, [guide_path],
                  "s/alpha/gamma/",
                  i=True,
                  index=dify_index)
