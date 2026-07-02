import pytest

from mirage.commands.builtin.dify.find import find
from mirage.core.dify import tree
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import document


async def list_basic_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Readme", "README.md"),
    ]


async def list_nested_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Guide 2", "guides/deep/note.md"),
        document("doc-3", "Readme", "README.md"),
    ]


@pytest.mark.asyncio
async def test_find_matches_name_pattern(monkeypatch, dify_accessor,
                                         dify_index, knowledge_root):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)

    stdout, _ = await find(dify_accessor, [knowledge_root],
                           "quick*.md",
                           index=dify_index)

    assert await materialize(stdout) == b"/knowledge/guides/quickstart.md\n"


@pytest.mark.asyncio
async def test_find_handles_file_missing_and_maxdepth(monkeypatch,
                                                      dify_accessor,
                                                      dify_index,
                                                      knowledge_root,
                                                      guide_path):
    monkeypatch.setattr(tree, "list_all_documents", list_basic_documents)

    file_stdout, file_io = await find(dify_accessor, [guide_path],
                                      index=dify_index)
    assert await materialize(file_stdout
                             ) == b"/knowledge/guides/quickstart.md\n"
    assert file_io.exit_code == 0

    maxdepth_stdout, maxdepth_io = await find(dify_accessor, [knowledge_root],
                                              maxdepth="0",
                                              index=dify_index)
    assert await materialize(maxdepth_stdout) == b"/knowledge\n"
    assert maxdepth_io.exit_code == 0

    missing = PathSpec.from_str_path(
        "/knowledge/missing.md",
        mount_key("/knowledge/missing.md", "/knowledge"))
    missing_stdout, missing_io = await find(dify_accessor, [missing],
                                            index=dify_index)
    assert await materialize(missing_stdout) == b""
    assert missing_io.stderr is not None
    assert b"/knowledge/missing.md" in missing_io.stderr
    assert missing_io.exit_code == 1


@pytest.mark.asyncio
async def test_find_uses_cwd_when_path_missing(monkeypatch, dify_accessor,
                                               dify_index, guides_path):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)

    stdout, io = await find(dify_accessor, [],
                            "quick*.md",
                            cwd=guides_path,
                            index=dify_index)

    assert await materialize(stdout) == b"/knowledge/guides/quickstart.md\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_find_resolves_glob_patterns(monkeypatch, dify_accessor,
                                           dify_index):
    monkeypatch.setattr(tree, "list_all_documents", list_nested_documents)
    path = PathSpec(resource_path=mount_key("/knowledge/guides/*.md",
                                            "/knowledge"),
                    virtual="/knowledge/guides/*.md",
                    directory="/knowledge/guides",
                    pattern="*.md",
                    resolved=False)

    stdout, io = await find(dify_accessor, [path], index=dify_index)

    assert await materialize(stdout) == b"/knowledge/guides/quickstart.md\n"
    assert io.exit_code == 0
