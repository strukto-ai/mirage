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

import datetime

import lancedb
import pytest

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.hierarchy.codec import PATH_SAFE
from mirage.core.lancedb.search import files_containing
from mirage.core.lancedb.tree import TREE
from mirage.core.vector.search import search_rows_output
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.lancedb.config import LanceDBConfig


async def _search(accessor, query: str, path: str, top_k: int = 1) -> str:
    spec = PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )
    out = await search_rows_output(
        TREE,
        accessor,
        query,
        [spec],
        top_k=top_k,
        threshold=0.0,
        mount_prefix="/db",
    )
    return "\n".join(record for _, record in out)


@pytest.mark.asyncio
async def test_search_emits_canonical_path_with_score(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals", 2)
    assert out.splitlines()[0].startswith("/db/animals/dog/small/4.md:")


@pytest.mark.asyncio
async def test_search_body_matches_card(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals")
    assert "# a small white dog" in out
    assert "label: dog" in out
    assert "score:" not in out


@pytest.mark.asyncio
async def test_search_spells_group_values_as_the_listing_does(edged):
    # A path the listing never shows is one ``cat`` cannot open: the group
    # segment renders the way readdir renders it, escape lead and all.
    for query, head in (
        ("one", "/db/docs/a∕b/1.md:"),
        ("two", "/db/docs/⁄/2.md:"),
        ("three", "/db/docs/⁄.env/3.md:"),
    ):
        out = await _search(edged, query, "/db/docs")
        assert out.splitlines()[0].startswith(head)


def _scope(path: str = "/db") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )


async def _cards(accessor, text, under, whole_word=False, ignore_case=False):
    out = await files_containing(
        accessor, text, under, whole_word, ignore_case
    )
    return None if out is None else [p.virtual for p in out]


# A card is `column: value` lines, so a string column holding the text is a
# card line holding it; the vector and blob columns are not rendered.
@pytest.mark.asyncio
async def test_files_containing_names_the_cards_a_string_column_holds(
    accessor,
):
    assert await _cards(accessor, "orange", [_scope()]) == [
        "/db/animals/cat/big/1.md"
    ]
    assert await _cards(accessor, "ORANGE", [_scope()], ignore_case=True) == [
        "/db/animals/cat/big/1.md"
    ]
    assert await _cards(accessor, "big", [_scope("/db/animals/dog")]) == [
        "/db/animals/dog/big/3.md"
    ]
    assert await _cards(accessor, "nowhere", [_scope()]) == []


# What a line can hold besides a string value: a column's name, the
# separator a leading space reaches into, a boolean or null, a digit.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text", ["name", "abe", "kind", "true", " big", "or4nge"]
)
async def test_files_containing_leaves_card_words_to_the_scan(accessor, text):
    assert await _cards(accessor, text, [_scope()]) is None


@pytest.mark.asyncio
async def test_files_containing_spells_group_values_as_the_listing(edged):
    assert await _cards(edged, "one", [_scope()]) == [
        f"/db/docs/{PATH_SAFE.encode('a/b')}/1.md"
    ]


@pytest.mark.asyncio
async def test_a_list_column_reads_every_card(tmp_path):
    uri = str(tmp_path / "lists")
    lancedb.connect(uri).create_table(
        "t", data=[{"id": 1, "tags": ["orange"], "name": "plain"}]
    )
    accessor = LanceDBAccessor(LanceDBConfig(uri=uri, id_column="id"))
    assert await _cards(accessor, "plain", [_scope()]) is None


# Every card spells its columns' names and the blob line's extension, and
# a duration spells words ("2 days, 0:00:00"): a text they can hold reads
# every card.
@pytest.mark.asyncio
async def test_card_labels_and_durations_read_every_card(tmp_path):
    uri = str(tmp_path / "labels")
    db = lancedb.connect(uri)
    db.create_table("named", data=[{"id": 1, "owner name": "Jane"}])
    db.create_table(
        "blobs", data=[{"id": 1, "name": "plain", "payload": b"x"}]
    )
    db.create_table(
        "timed", data=[{"id": 1, "late": datetime.timedelta(days=2)}]
    )

    def accessor(table: str, blob: str | None = None) -> LanceDBAccessor:
        return LanceDBAccessor(
            LanceDBConfig(
                uri=uri, table=table, id_column="id", blob_column=blob
            )
        )

    named = accessor("named")
    assert await _cards(named, "Jane", [_scope()]) == ["/db/1.md"]
    assert await _cards(named, "owner", [_scope()], whole_word=True) is None
    assert await _cards(named, "ner na", [_scope()]) is None
    assert (
        await _cards(accessor("blobs", "payload"), "bin", [_scope()]) is None
    )
    assert await _cards(accessor("timed"), "days", [_scope()]) is None


# A title drawn from the blob column is a card line like any other, so the
# search keeps that column.
@pytest.mark.asyncio
async def test_a_blob_title_is_searched(tmp_path):
    uri = str(tmp_path / "titled")
    lancedb.connect(uri).create_table(
        "t",
        data=[
            {"id": 1, "body": "orangeXX", "name": "plain"},
            {"id": 2, "body": "grey", "name": "plain"},
        ],
    )
    accessor = LanceDBAccessor(
        LanceDBConfig(
            uri=uri,
            table="t",
            id_column="id",
            blob_column="body",
            title_column="body",
        )
    )
    assert await _cards(accessor, "orange", [_scope()]) == ["/db/1.md"]


# A listing shows max_rows cards, so a text more rows hold reads the listed
# cards rather than fetching rows the walk never reaches.
@pytest.mark.asyncio
async def test_more_hits_than_a_listing_shows_read_every_card(tmp_path):
    uri = str(tmp_path / "wide")
    lancedb.connect(uri).create_table(
        "t", data=[{"id": i, "name": "plain row"} for i in range(5)]
    )

    def capped(max_rows: int) -> LanceDBAccessor:
        return LanceDBAccessor(
            LanceDBConfig(
                uri=uri, table="t", id_column="id", max_rows=max_rows
            )
        )

    assert await _cards(capped(4), "plain", [_scope()]) is None
    found = await _cards(capped(5), "plain", [_scope()])
    assert sorted(found or []) == [f"/db/{i}.md" for i in range(5)]
