import pytest

from mirage.commands.builtin.dify import COMMANDS
from mirage.commands.config import CommandCatalog, CommandOpts
from mirage.core.dify import stat, tree
from mirage.io.types import materialize
from mirage.vfs.dify import DifyVFS
from tests.fixtures.vfs_io import io_for

from .conftest import document

ls = CommandCatalog(COMMANDS).require("ls").fn


async def list_basic_documents(accessor):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Readme", "README.md"),
    ]


async def fail_get_detail(accessor, document_id):
    raise AssertionError("ls must not call get_document_detail")


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{}, {"args_l": True}], ids=["ls", "ls -l"])
async def test_ls_lists_virtual_tree_without_detail_calls(
    monkeypatch, dify_accessor, dify_index, knowledge_root, flags
):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    monkeypatch.setattr(stat, "get_document_detail", fail_get_detail)

    stdout, io = await ls(
        dify_accessor,
        [knowledge_root],
        [],
        CommandOpts(
            io=io_for(DifyVFS, dify_accessor), index=dify_index, flags=flags
        ),
    )

    output = (await materialize(stdout)).decode()
    rows = [r for r in output.splitlines() if not r.startswith("total ")]
    assert [row.split()[-1] for row in rows] == ["README.md", "guides"]
    assert output.endswith("\n")
    assert io.exit_code == 0
