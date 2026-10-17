import copy
import importlib
import json
from contextlib import aclosing
from pathlib import Path
from unittest.mock import Mock

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.core.api.errors import PaginationStalledError
from mirage.core.notion import pages as pages_mod
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.normalize import normalize_row
from mirage.core.render.json import jsonl_bytes
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec
from mirage.vfs.notion.notion import NotionVFS
from mirage.workspace import Workspace

READ = importlib.import_module("mirage.core.notion.read")
FIXTURES = Path(__file__).parents[4] / "integ/fixtures/notion"
STREAM = json.loads((FIXTURES / "streaming.json").read_text())
PAGINATION = json.loads((FIXTURES / "pagination.json").read_text())
VIRTUAL = "/notion/databases/DB__db/DS__ds/rows.jsonl"
ROWS = [
    row
    for reply in STREAM["responses"]
    for row in reply["results"]
    if row.get("object") == "page"
]
EXPECTED = jsonl_bytes([normalize_row(row) for row in ROWS])


class Replies:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def post(self, accessor, path, body):
        assert path == "/data_sources/ds/query"
        self.calls.append(dict(body))
        cursor = body.get("start_cursor")
        at = {None: 0, "c1": 1, "c2": 2}[cursor]
        reply = copy.deepcopy(self.responses[at])
        if "raise" in reply:
            raise NotionAPIError(**reply["raise"])
        for row in (
            reply.get("results", [])
            if isinstance(reply.get("results"), list)
            else []
        ):
            row.setdefault("object", "page")
        return reply


async def index_for(path, index):
    for segment in ("DB__db", "DS__ds"):
        virtual = path.virtual[: path.virtual.index(segment)] + segment
        await index.set_dir(
            virtual.rsplit("/", 1)[0],
            [
                (
                    segment,
                    FileStat(name=segment, type=FileType.DIRECTORY),
                )
            ],
        )
    await index.set_dir(
        VIRTUAL.rsplit("/", 1)[0],
        [
            (
                "rows.jsonl",
                FileStat(name="rows.jsonl", type=FileType.FILE),
            )
        ],
    )
    return index


@pytest.fixture
def replies(monkeypatch):
    replies = Replies(STREAM["responses"])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    return replies


@pytest.fixture
def path():
    return PathSpec(
        virtual=VIRTUAL,
        vfs_path=VIRTUAL.removeprefix("/notion/"),
        directory=VIRTUAL.rsplit("/", 1)[0],
    )


@pytest.fixture
def parent():
    return FileStat(name="DS__ds", type=FileType.DIRECTORY)


@pytest.mark.asyncio
async def test_stream_and_full_read_preserve_rendered_bytes(
    replies, path, parent
):
    accessor = NotionAccessor(NotionConfig(api_key="key"))
    assert await READ.read(accessor, path, None, parent) == EXPECTED
    replies.calls.clear()
    chunks = [
        chunk async for chunk in READ.read_stream(accessor, path, parent)
    ]
    assert b"".join(chunks) == EXPECTED
    assert len(chunks) == 2
    assert len(replies.calls) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "prefix", STREAM["prefixes"], ids=lambda p: f"lines-{p['n']}"
)
async def test_first_lines_render_only_the_requested_rows(
    monkeypatch, replies, path, parent, prefix
):
    normalize = Mock(wraps=normalize_row)
    monkeypatch.setattr(READ, "normalize_row", normalize)
    accessor = NotionAccessor(NotionConfig(api_key="key"))
    result = await READ.first_lines(accessor, path, prefix["n"], parent)
    assert result == b"".join(
        EXPECTED.splitlines(keepends=True)[: prefix["n"]]
    )
    assert len(replies.calls) == prefix["requests"]
    assert normalize.call_count == prefix["rows"]


@pytest.mark.asyncio
async def test_early_stream_close_stops_before_the_next_page(
    replies, path, parent
):
    stream = READ.read_stream(
        NotionAccessor(NotionConfig(api_key="key")),
        path,
        parent,
    )
    async with aclosing(stream):
        assert await anext(stream) == b"".join(
            EXPECTED.splitlines(keepends=True)[:2]
        )
    assert len(replies.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [case for case in PAGINATION if "error" in case],
    ids=lambda case: case["name"],
)
async def test_stream_does_not_hide_page_errors(
    monkeypatch, path, parent, case
):
    replies = Replies(case["responses"])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    with pytest.raises(
        (NotionAPIError, PaginationStalledError),
        match=case["error"]["message"],
    ):
        await materialize(
            READ.read_stream(
                NotionAccessor(NotionConfig(api_key="key")),
                path,
                parent,
            )
        )
    assert len(replies.calls) == len(case["cursors"])
    replies.calls.clear()
    with pytest.raises(
        (NotionAPIError, PaginationStalledError),
        match=case["error"]["message"],
    ):
        await READ.first_lines(
            NotionAccessor(NotionConfig(api_key="key")),
            path,
            100,
            parent,
        )
    assert len(replies.calls) == len(case["cursors"])


@pytest.mark.asyncio
async def test_empty_rows_stream_has_no_bytes(monkeypatch, path, parent):
    replies = Replies([{"results": [], "has_more": False}])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    assert (
        await materialize(
            READ.read_stream(
                NotionAccessor(NotionConfig(api_key="key")),
                path,
                parent,
            )
        )
        == b""
    )
    assert len(replies.calls) == 1


@pytest.mark.asyncio
async def test_metadata_stream_falls_back_to_a_full_read(
    monkeypatch, replies, path, parent
):
    async def get(accessor, endpoint):
        assert endpoint == "/data_sources/ds"
        return {"id": "ds", "title": [], "properties": {}}

    monkeypatch.setattr(pages_mod, "notion_get", get)
    metadata = PathSpec(
        virtual=path.virtual.replace("rows.jsonl", "data_source.json"),
        vfs_path=path.vfs_path.replace("rows.jsonl", "data_source.json"),
        directory=path.directory,
    )
    accessor = NotionAccessor(NotionConfig(api_key="key"))
    assert await READ.first_lines(accessor, metadata, 1, parent) is None
    assert await materialize(
        READ.read_stream(accessor, metadata, parent)
    ) == await READ.read(accessor, metadata, None, parent)
    assert replies.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command", [f"head -n 1 {VIRTUAL}", f"grep -l EARLY_MATCH {VIRTUAL}"]
)
async def test_shell_early_reads_do_not_cache_partial_files(
    replies, path, command
):
    vfs = NotionVFS(NotionConfig(api_key="key"))
    ws = Workspace({"/notion": vfs})
    await index_for(
        path, next(mount for mount in ws.mounts() if mount.vfs is vfs).index
    )
    try:
        result = await ws.shell(command, cwd="/")
        await result.materialize_stdout()
        assert result.exit_code == 0, await result.stderr_str()
        assert len(replies.calls) == 1
        assert await ws.cache.get(VIRTUAL) is None
        result = await ws.shell(f"cat {VIRTUAL}", cwd="/")
        assert await result.materialize_stdout() == EXPECTED
        assert result.exit_code == 0
        assert len(replies.calls) == 4
        assert await ws.cache.get(VIRTUAL) == EXPECTED
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_failed_stream_is_not_cached(monkeypatch, path):
    replies = Replies([STREAM["responses"][0], PAGINATION[-1]["responses"][1]])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    vfs = NotionVFS(NotionConfig(api_key="key"))
    ws = Workspace({"/notion": vfs})
    await index_for(
        path, next(mount for mount in ws.mounts() if mount.vfs is vfs).index
    )
    try:
        result = await ws.shell(f"cat {VIRTUAL}", cwd="/")
        await result.materialize_stdout()
        assert result.exit_code != 0
        assert await ws.cache.get(VIRTUAL) is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_new_read_paths_still_refuse_an_unlisted_parent(replies, path):
    accessor = NotionAccessor(NotionConfig(api_key="key"))
    with pytest.raises(FileNotFoundError):
        await materialize(READ.read_stream(accessor, path))
    with pytest.raises(FileNotFoundError):
        await READ.first_lines(accessor, path, 1)
    assert replies.calls == []
