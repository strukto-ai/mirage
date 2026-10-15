# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from types import SimpleNamespace

import aiohttp
import pytest

import mirage.core.google.search as search_mod
from mirage.core.google.search import drive_queries, files_containing
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.generated.google_vocabulary import DOCS_WORDS

MIME = "application/vnd.google-apps.document"
CORPORA = {
    "owned": [("a", "doc-a"), ("b", "doc-b")],
    "shared": [("c", "doc-c")],
}


def _rows(key: str) -> list[FileStat]:
    return [
        FileStat(
            name=f"{name}.gdoc.json",
            type=FileType.FILE,
            extra={"doc_id": file_id, "doc_name": name},
        )
        for name, file_id in CORPORA[key]
    ]


async def _readdir(accessor, path: PathSpec) -> DirListing:
    return DirListing(entries=_rows(path.vfs_path.strip("/")))


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/docs/" + vfs_path if vfs_path else "/docs"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


def _answer(monkeypatch, ids, complete=True, fail=None) -> list[tuple]:
    asked: list[tuple] = []

    async def search_files(token_manager, text, parent_ids, mime_type=None):
        asked.append((text, parent_ids, mime_type))
        if fail is not None:
            raise fail
        return ids, complete

    monkeypatch.setattr(search_mod, "search_files", search_files)
    return asked


async def _ask(text: str, under: list[PathSpec]) -> list[PathSpec] | None:
    accessor = SimpleNamespace(token_manager=None)
    return await files_containing(
        accessor, _readdir, MIME, DOCS_WORDS, text, under
    )


# A word the rendered JSON may hold whatever the text says is never asked:
# one with a digit, one of the API's names, a JSON literal, one every
# rendering carries, one an id can hold. A word an escape can run into is
# asked without its first letter too (`\notes` holds "otes").
@pytest.mark.parametrize(
    "text, queries",
    [
        ("wombat", ["wombat"]),
        ("Wombat", ["Wombat"]),
        ("notes", ["notes", "otes"]),
        ("q4", None),
        ("2024", None),
        ("paragraph", None),
        ("TextRun", None),
        ("NORMAL_TEXT", None),
        ("false", None),
        ("arial", None),
        ("https", None),
        ("face", None),
    ],
)
def test_drive_queries_turn_down_the_rendering_words(text, queries):
    assert drive_queries(text, DOCS_WORDS) == queries


@pytest.mark.asyncio
async def test_the_answer_is_the_walked_files_drive_names(monkeypatch):
    asked = _answer(monkeypatch, ["doc-a", "doc-c", "elsewhere"])
    out = await _ask("wombat", [_scope()])
    assert out is not None
    assert [p.virtual for p in out] == [
        "/docs/owned/a.gdoc.json",
        "/docs/shared/c.gdoc.json",
    ]
    assert asked == [("wombat", [], MIME)]


@pytest.mark.asyncio
async def test_a_corpus_scope_walks_only_itself(monkeypatch):
    _answer(monkeypatch, ["doc-a", "doc-c"])
    out = await _ask("wombat", [_scope("owned")])
    assert out is not None
    assert [p.vfs_path for p in out] == ["owned/a.gdoc.json"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, under, ids, complete, fail",
    [
        ("paragraph", [""], ["doc-a"], True, None),
        ("wombat", ["owned/a.gdoc.json"], ["doc-a"], True, None),
        ("wombat", [""], ["doc-a"], False, None),
        ("wombat", [""], [], True, None),
        ("wombat", [""], ["doc-a"], True, aiohttp.ClientError("down")),
    ],
)
async def test_an_unsure_answer_reads_every_file(
    monkeypatch, text, under, ids, complete, fail
):
    _answer(monkeypatch, ids, complete, fail)
    assert await _ask(text, [_scope(u) for u in under]) is None


@pytest.mark.asyncio
async def test_each_query_is_asked_and_their_answers_joined(monkeypatch):
    asked = _answer(monkeypatch, ["doc-b"])
    out = await _ask("notes", [_scope("owned")])
    assert out is not None
    assert [p.vfs_path for p in out] == ["owned/b.gdoc.json"]
    assert [query for query, _, _ in asked] == ["notes", "otes"]


async def _unfinished(accessor, path: PathSpec) -> DirListing:
    return DirListing(entries=_rows(path.vfs_path.strip("/")), partial=True)


# Drive could not finish the listing, so it is not the directory, and
# grep's own walk lists it again and may find more.
@pytest.mark.asyncio
async def test_an_unfinished_listing_reads_every_file(monkeypatch):
    _answer(monkeypatch, ["a.gdoc.json"])
    accessor = SimpleNamespace(token_manager=None)
    out = await files_containing(
        accessor,
        _unfinished,
        MIME,
        DOCS_WORDS,
        "wombat",
        [_scope("owned")],
    )
    assert out is None
