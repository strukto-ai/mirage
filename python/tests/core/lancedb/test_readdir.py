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

import lancedb
import pytest

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.lancedb.readdir import readdir
from mirage.types import PathSpec
from mirage.vfs.lancedb.config import LanceDBConfig


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _names(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in paths}


@pytest.mark.asyncio
async def test_root_lists_table(accessor):
    out = await readdir(accessor, _ps("/"))
    assert _names(out) == {"animals"}


@pytest.mark.asyncio
async def test_table_lists_groups(accessor):
    out = await readdir(accessor, _ps("/animals"))
    assert _names(out) == {"cat", "dog"}


@pytest.mark.asyncio
async def test_group_lists_next_level(accessor):
    out = await readdir(accessor, _ps("/animals/cat"))
    assert _names(out) == {"big", "small"}


@pytest.mark.asyncio
async def test_leaf_lists_row_files(accessor):
    out = await readdir(accessor, _ps("/animals/cat/big"))
    assert _names(out) == {"1.md", "1.png"}


def _globbed(path: str, pattern: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    vfs_path=path.strip("/"),
                    pattern=pattern)


CAP = 5
WIDE = 40


@pytest.fixture
def capped(tmp_path) -> LanceDBAccessor:
    """A table wider than its own row cap, in one group.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    uri = str(tmp_path / "wide")
    db = lancedb.connect(uri)
    db.create_table("wide",
                    data=[{
                        "id": f"doc-{i:03d}",
                        "label": "all",
                        "name": f"n{i}",
                        "vector": [0.1, 0.2],
                    } for i in range(WIDE)])
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      table="wide",
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name",
                      max_rows=CAP))


@pytest.mark.asyncio
async def test_a_row_glob_reaches_past_the_cap(capped):
    # The cap covers doc-000..doc-004, so filtering it would answer
    # nothing; the prefix goes into the query instead.
    out = await readdir(capped, _globbed("/all", "doc-03*"))
    assert _names(out) == {f"doc-03{i}.md" for i in range(CAP)}


@pytest.mark.asyncio
async def test_a_glob_with_no_literal_head_stays_capped(capped):
    # Neither backend can narrow on a leading metacharacter, so this one
    # is the ordinary capped listing that the glob then filters.
    out = await readdir(capped, _globbed("/all", "*9.md"))
    assert _names(out) == {f"doc-00{i}.md" for i in range(CAP)}


@pytest.mark.asyncio
async def test_a_narrowed_listing_is_not_cached_as_the_directory(capped):
    index = RAMIndexCacheStore()
    await readdir(capped, _globbed("/all", "doc-03*"), index)
    listing = await index.list_dir("/all/")
    assert listing.entries is None
    plain = await readdir(capped, _ps("/all"), index)
    assert _names(plain) == {f"doc-00{i}.md" for i in range(CAP)}


@pytest.fixture
def underscored(tmp_path) -> LanceDBAccessor:
    """Ids whose own text contains a LIKE metacharacter.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    uri = str(tmp_path / "meta")
    db = lancedb.connect(uri)
    db.create_table("meta",
                    data=[{
                        "id": rid,
                        "label": "all",
                        "name": rid,
                        "vector": [0.1, 0.2],
                    } for rid in ("doc_1", "doc_2", "docX1", "a%b", "axb")])
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      table="meta",
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name",
                      max_rows=2))


@pytest.mark.asyncio
async def test_a_like_metacharacter_in_the_prefix_is_escaped(underscored):
    # An unescaped `_` is LIKE's single-character wildcard, so docX1 would
    # ride along and could crowd a real match out of the row cap.
    out = await readdir(underscored, _globbed("/all", "doc_*"))
    assert _names(out) == {"doc_1.md", "doc_2.md"}
    out = await readdir(underscored, _globbed("/all", "a%*"))
    assert _names(out) == {"a%b.md"}


@pytest.fixture
def slashed(tmp_path) -> LanceDBAccessor:
    """Group values a raw rendering loses: a slash, its stand-in, a blank
    value and a dot-led one.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    uri = str(tmp_path / "slashed")
    db = lancedb.connect(uri)
    db.create_table("docs",
                    data=[{
                        "id": 1,
                        "label": "a/b",
                        "name": "one",
                        "vector": [0.1, 0.2],
                    }, {
                        "id": 2,
                        "label": "a∕b",
                        "name": "two",
                        "vector": [0.1, 0.2],
                    }, {
                        "id": 3,
                        "label": "",
                        "name": "three",
                        "vector": [0.1, 0.2],
                    }, {
                        "id": 4,
                        "label": ".env",
                        "name": "four",
                        "vector": [0.1, 0.2],
                    }])
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      table="docs",
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name"))


@pytest.mark.asyncio
async def test_a_value_holding_a_slash_keeps_its_own_directory(slashed):
    # ``a/b`` renders as ``a∕b`` and ``a∕b`` as ``a⁄∕b``, so neither hides
    # the other, and each directory filters for exactly its own value.
    root = await readdir(slashed, _ps("/"))
    assert _names(root) == {"a∕b", "a⁄∕b", "⁄", "⁄.env"}
    assert _names(await readdir(slashed, _ps("/a∕b"))) == {"1.md"}
    assert _names(await readdir(slashed, _ps("/a⁄∕b"))) == {"2.md"}


@pytest.mark.asyncio
async def test_a_blank_or_dot_led_value_keeps_a_directory_that_opens(slashed):
    # A blank value rendered as ``unknown`` and a dot-led one as a hidden
    # segment; each carries the escape lead and filters for its own value.
    assert _names(await readdir(slashed, _ps("/⁄"))) == {"3.md"}
    assert _names(await readdir(slashed, _ps("/⁄.env"))) == {"4.md"}


@pytest.mark.asyncio
async def test_a_group_glob_narrows_on_the_decoded_value(slashed):
    # The glob's literal head is spelled in rendered names; the query
    # takes the value prefix it stands for and the listing keeps only
    # the rendered names that really start with the head.
    assert _names(await readdir(slashed, _globbed("/", "a∕*"))) == {"a∕b"}
    assert _names(await readdir(slashed, _globbed("/",
                                                  "a*"))) == {"a∕b", "a⁄∕b"}


@pytest.fixture
def crowded(tmp_path) -> LanceDBAccessor:
    """Values whose rendering starts with the escape lead, every one of
    them past a cap the head of the table fills.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    uri = str(tmp_path / "crowded")
    db = lancedb.connect(uri)
    rows = [{
        "id": i,
        "label": "all",
        "name": f"n{i}",
        "vector": [0.1, 0.2],
    } for i in range(WIDE)]
    rows += [{
        "id": WIDE + i,
        "label": label,
        "name": label,
        "vector": [0.1, 0.2],
    } for i, label in enumerate(("", ".env", "a∕x"))]
    db.create_table("crowded", data=rows)
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      table="crowded",
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name",
                      max_rows=CAP))


@pytest.mark.asyncio
async def test_a_glob_head_no_value_prefix_spells_reaches_past_the_cap(
        crowded):
    # ``⁄`` alone stands for no value prefix (a blank value, a dot-led one,
    # one opening with ``∕`` or ``⁄`` all render behind it), so nothing
    # narrows the query; the cap counts the renderings that match rather
    # than the rows at the head of the table. The plain listing stays capped.
    assert _names(await readdir(crowded, _ps("/"))) == {"all"}
    assert _names(await readdir(crowded, _globbed("/",
                                                  "⁄*"))) == {"⁄", "⁄.env"}


@pytest.mark.asyncio
async def test_a_glob_head_cut_inside_an_escape_counts_matches(crowded):
    # ``a⁄`` decodes to ``a``, which every ``all`` row also starts with: the
    # LIKE loses nothing, and the cap counts the renderings that really
    # start with ``a⁄`` rather than the rows the LIKE let through.
    assert _names(await readdir(crowded, _globbed("/", "a⁄*"))) == {"a⁄∕x"}
