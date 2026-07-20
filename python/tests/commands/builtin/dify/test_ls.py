import pytest

from mirage.commands.builtin.dify import COMMANDS
from mirage.core.dify import stat, tree
from mirage.io.types import materialize

from .conftest import document

ls = next(cmd for cmd in COMMANDS if cmd._registered_commands[0].name == "ls")


async def list_basic_documents(accessor):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Readme", "README.md"),
    ]


async def fail_get_detail(accessor, document_id):
    raise AssertionError("ls must not call get_document_detail")


@pytest.mark.asyncio
async def test_ls_lists_virtual_tree_without_detail_calls(
        monkeypatch, dify_accessor, dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(stat, "get_document_detail", fail_get_detail)

    stdout, io = await ls(dify_accessor, [knowledge_root], index=dify_index)

    assert await materialize(stdout) == b"README.md\nguides\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_ls_long_listing_uses_light_stat(monkeypatch, dify_accessor,
                                               dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(stat, "get_document_detail", fail_get_detail)

    stdout, io = await ls(dify_accessor, [knowledge_root],
                          args_l=True,
                          index=dify_index)

    output = await materialize(stdout)
    assert b"README.md" in output
    assert b"guides" in output
    assert io.exit_code == 0
