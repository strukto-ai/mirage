from unittest.mock import AsyncMock

import pytest

from mirage.core.dify import tree
from mirage.vfs.dify import DifyVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

from .conftest import document


async def list_basic_documents(accessor):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Readme", "README.md"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["ls /knowledge", "ls -l /knowledge"])
async def test_ls_lists_the_virtual_tree(monkeypatch, dify_accessor, line):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)
    dify_accessor.close = AsyncMock()
    ws = Workspace({"/knowledge/": vfs_over(DifyVFS, dify_accessor)})
    try:
        result = await ws.shell(line)
        output = await result.stdout_str()
    finally:
        await ws.close()

    rows = [r for r in output.splitlines() if not r.startswith("total ")]
    assert [row.split()[-1] for row in rows] == ["README.md", "guides"]
    assert output.endswith("\n")
    assert result.exit_code == 0
