import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mirage.commands.cli.builtin.search import SEARCH, search
from mirage.commands.config import Context
from mirage.commands.spec.parser import parse_command
from mirage.core.dify import search as dify_search
from mirage.types import MountMode, PathSpec, SearchQuery
from mirage.vfs.dify import DifyVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.core.chroma.conftest import FakeCollection
from tests.fixtures.vfs_io import StubAccessor, vfs_over

PATH = PathSpec(virtual="/data", directory="/", vfs_path="")


def test_the_spec_parses_query_paths_and_options():
    parsed = parse_command(
        SEARCH.spec,
        [
            "--method",
            "hybrid",
            "--top-k",
            "5",
            "--threshold",
            "0.4",
            "login docs",
            "guides/*.md",
        ],
        cwd="/knowledge",
    )

    assert parsed.flags["--method"] == "hybrid"
    assert parsed.flags["--top-k"] == "5"
    assert parsed.flags["--threshold"] == "0.4"
    assert parsed.args == [
        ("login docs", "str"),
        ("/knowledge/guides/*.md", "path"),
    ]


def _ctx(dispatch: AsyncMock, flags: dict | None = None) -> Context:
    return Context(
        flags=flags or {},
        spec=SEARCH.spec,
        vfs=SimpleNamespace(dispatch=dispatch),
    )


# The mount answers an option the line leaves out with its own default,
# so only the options the line names reach it.
@pytest.mark.asyncio
async def test_a_query_is_one_search_over_every_scope():
    dispatch = AsyncMock(
        return_value=([("/data/a", "highest"), ("/data/b", "second")], None)
    )
    out, _ = await search(
        None, [PATH, PATH], ["question"], _ctx(dispatch, {"top_k": "2"})
    )
    assert out == b"highest\nsecond\n"
    dispatch.assert_awaited_once_with(
        "search",
        PATH,
        query=SearchQuery("question", options={"top_k": 2}),
        scopes=[PATH],
    )


@pytest.mark.asyncio
async def test_a_declined_search_does_not_become_no_matches():
    dispatch = AsyncMock(return_value=(None, None))
    with pytest.raises(NotImplementedError, match="declined"):
        await search(None, [PATH], ["query"], _ctx(dispatch))


@pytest.mark.asyncio
async def test_mounting_a_store_does_not_register_search():
    vfs = build_vfs("chroma", {"collection_name": "docs"})
    vfs.accessor._collection = FakeCollection()
    ws = Workspace({"/knowledge": Mount(vfs=vfs, mode=MountMode.READ)})
    try:
        result = await ws.shell("search refunds /knowledge")
        assert result.exit_code == 127
    finally:
        await ws.close()


def _chroma(collection: FakeCollection) -> Workspace:
    collection.documents["__path_tree__"] = json.dumps({"a.md": {"size": 1}})
    vfs = build_vfs("chroma", {"collection_name": "docs"})
    vfs.accessor._collection = collection
    ws = Workspace({"/knowledge": Mount(vfs=vfs, mode=MountMode.READ)})
    ws.register_cli("search", SEARCH)
    return ws


# The line's own grammar is a usage error, exit 2; a value the mount
# cannot take fails like the mount, exit 1. Either way Chroma is not
# asked.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cmd,exit_code,stderr",
    [
        (
            "search --top-k many refunds /knowledge",
            2,
            "search: invalid int value: 'many' for '--top-k'\n"
            "Try 'search --help' for more information.\n",
        ),
        (
            "search --bogus refunds /knowledge",
            2,
            "search: unrecognized option '--bogus'\n"
            "Try 'search --help' for more information.\n",
        ),
        (
            "search --top-k 0 refunds /knowledge",
            2,
            "search: top-k must be positive\n",
        ),
        ("search '' /knowledge", 2, "search: query is required\n"),
        (
            "search --method keyword refunds /knowledge",
            1,
            "search: only the 'semantic' method is supported\n",
        ),
    ],
)
async def test_a_refused_option_never_asks_chroma(cmd, exit_code, stderr):
    collection = FakeCollection()
    ws = _chroma(collection)
    try:
        result = await ws.shell(cmd)
        assert result.exit_code == exit_code
        assert await result.stderr_str() == stderr
        assert collection.queries == []
    finally:
        await ws.close()


class _DownCollection(FakeCollection):
    async def query(self, **kwargs):
        raise RuntimeError("chroma is down")


# A failed search reads like any command's failure: the command's name,
# then the path and its errno text, or the service's message.
@pytest.mark.asyncio
async def test_a_failure_names_search():
    ws = _chroma(_DownCollection())
    try:
        missing = await ws.shell("search refunds /knowledge/nope")
        down = await ws.shell("search refunds /knowledge")
        assert (missing.exit_code, await missing.stderr_str()) == (
            1,
            "search: /knowledge/nope: No such file or directory\n",
        )
        assert (down.exit_code, await down.stderr_str()) == (
            1,
            "search: chroma is down\n",
        )
    finally:
        await ws.close()


def _dify(monkeypatch, posted: list[dict]) -> Workspace:
    async def dify_post(accessor, path, body):
        posted.append(body)
        return {"records": []}

    monkeypatch.setattr(dify_search, "dify_post", dify_post)
    accessor = StubAccessor(
        config=SimpleNamespace(slug_metadata_name="slug", dataset_id="kb")
    )
    ws = Workspace({"/knowledge/": vfs_over(DifyVFS, accessor)})
    ws.register_cli("search", SEARCH)
    return ws


@pytest.mark.asyncio
async def test_dify_answers_the_options_a_line_leaves_out(monkeypatch):
    posted: list[dict] = []
    ws = _dify(monkeypatch, posted)
    try:
        result = await ws.shell("search anything /knowledge")
        assert result.exit_code == 0
        assert posted == [
            {
                "query": "anything",
                "retrieval_model": {
                    "search_method": "semantic_search",
                    "top_k": 10,
                    "score_threshold_enabled": False,
                    "score_threshold": 0.0,
                    "reranking_enable": False,
                },
            }
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options,exit_code,stderr",
    [
        ("--method ''", 1, "method must be one of"),
        ("--method vector", 1, "method must be one of"),
        ("--threshold 1.2", 1, r"threshold must be in [0, 1]"),
        ("--top-k 0", 2, "top-k must be positive"),
    ],
)
async def test_dify_is_not_asked_for_an_option_it_refuses(
    monkeypatch, options, exit_code, stderr
):
    posted: list[dict] = []
    ws = _dify(monkeypatch, posted)
    try:
        result = await ws.shell(f"search {options} anything /knowledge")
        assert result.exit_code == exit_code
        assert stderr in await result.stderr_str()
        assert posted == []
    finally:
        await ws.close()
