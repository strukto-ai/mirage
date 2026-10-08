from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.chroma import COMMANDS as CHROMA_COMMANDS
from mirage.commands.builtin.dify import COMMANDS
from mirage.commands.builtin.find_parse import parse_find_expression
from mirage.commands.builtin.slug_tree.find import (
    _default_name,
    _expr_texts,
    reads_sizes,
    reads_times,
)
from mirage.commands.config import CommandOpts
from mirage.context import reset_current_session, set_current_session
from mirage.core.dify import tree
from mirage.io.types import IOResult, materialize
from mirage.types import HiddenPaths, PathSpec, Visibility
from mirage.utils.hidden import hidden_under
from mirage.utils.key_prefix import mount_key
from mirage.vfs.chroma import ChromaVFS
from mirage.vfs.dify import DifyVFS
from mirage.view.types import NamespaceView
from mirage.workspace.session import SessionState
from tests.commands.builtin.dify.conftest import document
from tests.core.chroma.conftest import accessor_for, seeded_collection
from tests.fixtures.vfs_io import io_for

find = next(
    cmd for cmd in COMMANDS if cmd._registered_commands[0].name == "find"
)
chroma_find = next(
    cmd
    for cmd in CHROMA_COMMANDS
    if cmd._registered_commands[0].name == "find"
)


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual, mount_key(virtual, "/knowledge"))


async def list_documents(config):
    return [
        document("doc-1", "Guide", "guides/quickstart.md"),
        document("doc-2", "Guide 2", "guides/deep/note.md"),
        document("doc-3", "Readme", "README.md"),
    ]


@pytest.fixture(autouse=True)
def documents(monkeypatch):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)


def view(vis: Visibility) -> NamespaceView:
    return NamespaceView(
        visibility=vis, scoped=lambda virtual: hidden_under(vis, virtual)
    )


async def run(
    paths: list[PathSpec], texts: list[str], **opts
) -> tuple[bytes, IOResult]:
    accessor = SimpleNamespace(
        config=SimpleNamespace(slug_metadata_name="slug")
    )
    stdout, io = await find(
        accessor,
        paths,
        texts,
        CommandOpts(
            index=RAMIndexCacheStore(),
            io=io_for(DifyVFS, accessor),
            **opts,
        ),
    )
    return await materialize(stdout), io


@pytest.mark.asyncio
async def test_a_bare_word_is_the_name_filter():
    stdout, io = await run([spec("/knowledge")], ["quick*.md"])

    assert stdout == b"/knowledge/guides/quickstart.md\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_find_handles_file_missing_and_maxdepth():
    guide = spec("/knowledge/guides/quickstart.md")
    assert (await run([guide], []))[0] == b"/knowledge/guides/quickstart.md\n"
    assert (await run([spec("/knowledge")], [], flags={"maxdepth": "0"}))[
        0
    ] == b"/knowledge\n"

    stdout, io = await run([spec("/knowledge/missing.md")], [])
    assert stdout == b""
    assert io.stderr is not None
    assert b"/knowledge/missing.md" in io.stderr
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_find_uses_cwd_when_path_missing():
    guides = PathSpec(
        vfs_path=mount_key("/knowledge/guides", "/knowledge"),
        virtual="/knowledge/guides",
        directory="/knowledge/guides",
    )

    stdout, _ = await run([], ["quick*.md"], cwd=guides)

    assert stdout == b"/knowledge/guides/quickstart.md\n"


@pytest.mark.asyncio
async def test_find_resolves_glob_patterns():
    path = PathSpec(
        vfs_path=mount_key("/knowledge/guides/*.md", "/knowledge"),
        virtual="/knowledge/guides/*.md",
        directory="/knowledge/guides",
        pattern="*.md",
        resolved=False,
    )

    assert (await run([path], []))[0] == b"/knowledge/guides/quickstart.md\n"


@pytest.mark.parametrize(
    "texts",
    [
        ["!", "-name", "x"],
        ["(", "-name", "a", "-o", "-name", "b", ")"],
        ["-name", "x"],
        ["-not", "-name", "x"],
    ],
)
def test_expr_texts_preserves_expression(texts):
    assert _expr_texts(texts) == texts


def test_expr_texts_strips_bare_leading_name():
    assert _expr_texts(["foo"]) == []
    assert _expr_texts([]) == []


def test_default_name_only_for_bare_word():
    assert _default_name(None, ["foo"]) == "foo"
    assert _default_name(None, ["!", "-name", "x"]) is None
    assert _default_name(None, ["(", "-name", "a"]) is None
    assert _default_name("given", ["foo"]) == "given"


@pytest.mark.parametrize(
    "texts, times, sizes",
    [
        (["-name", "*.md"], False, False),
        (["-name", "-size"], False, False),
        (["-mtime", "-1"], True, False),
        (["-mtime", "+0", "-o", "-mtime", "-1"], True, False),
        (["-newer", "/knowledge/README.md"], True, False),
        (["-newermt", "2024-01-01"], True, False),
        (["-size", "+1k"], False, True),
        (["!", "-empty"], False, True),
        (["-printf", "%TY %s\n"], False, False),
    ],
)
def test_which_fields_an_expression_tests(texts, times, sizes):
    expr = parse_find_expression(texts)
    assert (reads_times(expr), reads_sizes(expr)) == (times, sizes)


_SIZED = ["-type", "f", "-size", "+0"]
_SIZED_FLAGS = {"type": "f", "size": "+0"}
_NEWER = ["-type", "f", "-newermt", "2026-01-15"]
_QUICKSTART = "/knowledge/guides/quickstart"
_REFERENCE = "/knowledge/api/reference"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "hidden, texts, flags, rows, scans",
    [
        (_QUICKSTART, _SIZED, {}, [_REFERENCE], True),
        (None, _SIZED, {}, [_REFERENCE, _QUICKSTART], True),
        (_QUICKSTART, [], _SIZED_FLAGS, [_REFERENCE], True),
        (_REFERENCE, _NEWER, {}, [_QUICKSTART], False),
        (None, _NEWER, {}, [_QUICKSTART], False),
    ],
)
async def test_chroma_scans_chunks_only_for_a_size_test(
    hidden, texts, flags, rows, scans
):
    collection = seeded_collection()
    vis = Visibility(paths=HiddenPaths(paths=(hidden,) if hidden else ()))
    session = SessionState(session_id="veiled", visibility=vis)
    token = set_current_session(session)
    try:
        accessor = accessor_for(collection)
        stdout, io = await chroma_find(
            accessor,
            [spec("/knowledge")],
            texts,
            CommandOpts(
                index=RAMIndexCacheStore(),
                io=io_for(ChromaVFS, accessor),
                flags=flags,
                ns=view(vis),
            ),
        )
        stdout = await materialize(stdout)
    finally:
        reset_current_session(token)

    assert stdout.decode().splitlines() == rows
    assert io.exit_code == 0
    assert any("where" in call for call in collection.get_calls) is scans


@pytest.mark.asyncio
async def test_a_hidden_child_leaves_its_directory_empty():
    vis = Visibility(
        paths=HiddenPaths(paths=("/knowledge/guides/deep/note.md",))
    )
    session = SessionState(session_id="veiled", visibility=vis)
    token = set_current_session(session)
    try:
        stdout, io = await run(
            [spec("/knowledge/guides")], ["-empty"], ns=view(vis)
        )
    finally:
        reset_current_session(token)

    assert stdout == b"/knowledge/guides/deep\n"
    assert io.exit_code == 0
