import pytest

from mirage import Workspace
from mirage.core.dify import tree
from mirage.vfs.registry import build_vfs
from tests.commands.builtin.dify.conftest import document

CONFIG = {
    "api_key": "dataset-secret",
    "base_url": "https://api.dify.ai/v1/",
    "dataset_id": "dataset-1",
}


@pytest.fixture
def listings(monkeypatch) -> list[int]:
    calls: list[int] = []

    async def list_documents(config):
        calls.append(1)
        return [
            document("doc-1", "Guide", "guides/quickstart.md"),
            document("doc-2", "Guide 2", "guides/deep/note.md"),
            document("doc-3", "Readme", "README.md"),
        ]

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    return calls


async def _run(line: str) -> tuple[str, str, int]:
    ws = Workspace({"/knowledge": build_vfs("dify", CONFIG)})
    io = await ws.shell(line)
    return await io.stdout_str(), await io.stderr_str(), io.exit_code


@pytest.mark.asyncio
async def test_find_walks_the_tree_from_one_listing(listings):
    stdout, stderr, code = await _run("find /knowledge")
    assert stdout.splitlines() == [
        "/knowledge",
        "/knowledge/README.md",
        "/knowledge/guides",
        "/knowledge/guides/deep",
        "/knowledge/guides/deep/note.md",
        "/knowledge/guides/quickstart.md",
    ]
    assert (stderr, code) == ("", 0)
    assert listings == [1]


@pytest.mark.asyncio
async def test_find_filters_names_and_depth(listings):
    stdout, _, _ = await _run("find /knowledge -name 'quick*.md'")
    assert stdout == "/knowledge/guides/quickstart.md\n"
    stdout, _, _ = await _run("find /knowledge -maxdepth 0")
    assert stdout == "/knowledge\n"


@pytest.mark.asyncio
async def test_find_reports_a_missing_operand(listings):
    stdout, stderr, code = await _run("find /knowledge/missing.md")
    assert stdout == ""
    assert stderr == (
        "find: '/knowledge/missing.md': No such file or directory\n"
    )
    assert code == 1
