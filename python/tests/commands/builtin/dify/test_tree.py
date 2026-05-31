import pytest

from mirage.commands.builtin.dify.tree import tree as tree_cmd
from mirage.core.dify import tree
from mirage.io.types import materialize

from .conftest import document


async def list_nested_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Deep", "guides/deep/note.md"),
        document("doc-3", "Readme", "README.md"),
    ]


@pytest.mark.asyncio
async def test_tree_renders_nested_dify_tree(monkeypatch, dify_accessor,
                                             dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)

    stdout, io = await tree_cmd(dify_accessor, [knowledge_root],
                                index=dify_index)

    assert (await materialize(stdout)).decode() == (
        "\u251c\u2500\u2500 README.md\n"
        "\u2514\u2500\u2500 guides\n"
        "    \u251c\u2500\u2500 deep\n"
        "    \u2502   \u2514\u2500\u2500 note.md\n"
        "    \u2514\u2500\u2500 quickstart.md")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tree_uses_cwd_and_depth(monkeypatch, dify_accessor, dify_index,
                                       guides_path):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)

    stdout, _ = await tree_cmd(dify_accessor, [],
                               L="1",
                               cwd=guides_path,
                               index=dify_index)

    assert (await materialize(stdout)).decode() == (
        "\u251c\u2500\u2500 deep\n"
        "\u2502   \u2514\u2500\u2500 note.md\n"
        "\u2514\u2500\u2500 quickstart.md")
