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

from urllib.parse import parse_qs

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.google.search import drive_queries, files_containing
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.clock import ManualClock
from mirage.utils.generated.google_vocabulary import DOCS_WORDS
from tests.fixtures.google_account import FILES, UNTIL_CLEARED

MIME = "application/vnd.google-apps.document"


async def _corpora(
    google_account, names: dict[str, str]
) -> dict[str, list[tuple[str, str]]]:
    """Make a doc per row name, each named with the words its text holds
    (a Drive search reads a file's name too), and answer the corpora the
    app lists them in: a and b owned, c shared. A name the rows do not
    name is a doc the walk never reaches.

    Args:
        google_account (GoogleAccount): the account.
        names (dict[str, str]): row name to the doc's Drive name.
    """
    ids = {
        key: await google_account.create(name, MIME)
        for key, name in names.items()
    }
    return {
        "owned": [(k, ids[k]) for k in ("a", "b") if k in ids],
        "shared": [(k, ids[k]) for k in ("c",) if k in ids],
    }


def _readdir_over(corpora, partial: bool = False):
    async def readdir(accessor, path: PathSpec) -> DirListing:
        rows = [
            FileStat(
                name=f"{name}.gdoc.json",
                type=FileType.FILE,
                extra={"doc_id": file_id, "doc_name": name},
            )
            for name, file_id in corpora[path.vfs_path.strip("/")]
        ]
        return DirListing(entries=rows, partial=partial)

    return readdir


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/docs/" + vfs_path if vfs_path else "/docs"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _ask(
    google_account, corpora, text: str, under: list[PathSpec], clock=None
) -> list[PathSpec] | None:
    manager = google_account.token_manager(clock)
    accessor = GDocsAccessor(config=manager.config, token_manager=manager)
    return await files_containing(
        accessor, _readdir_over(corpora), MIME, DOCS_WORDS, text, under
    )


async def _searched(google_account) -> list[tuple[str, list[str], bool]]:
    """Each search asked since recording started: its words, the folders
    it asked in, and whether it named the app's MIME type."""
    return [
        (
            listing.text,
            listing.folders,
            f"mimeType='{MIME}'" in parse_qs(listing.query)["q"][0],
        )
        for listing in await google_account.listings()
        if listing.text is not None
    ]


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


WOMBATS = {
    "a": "a wombat",
    "b": "b",
    "c": "c wombat",
    "elsewhere": "elsewhere wombat",
}


@pytest.mark.asyncio
async def test_the_answer_is_the_walked_files_drive_names(google_account):
    corpora = await _corpora(google_account, WOMBATS)
    await google_account.run.record_requests()
    out = await _ask(google_account, corpora, "wombat", [_scope()])
    assert out is not None
    assert [p.virtual for p in out] == [
        "/docs/owned/a.gdoc.json",
        "/docs/shared/c.gdoc.json",
    ]
    assert await _searched(google_account) == [("wombat", [], True)]


@pytest.mark.asyncio
async def test_a_corpus_scope_walks_only_itself(google_account):
    corpora = await _corpora(google_account, WOMBATS)
    out = await _ask(google_account, corpora, "wombat", [_scope("owned")])
    assert out is not None
    assert [p.vfs_path for p in out] == ["owned/a.gdoc.json"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    ["no query", "a file scope", "incomplete", "no hit", "search fails"],
)
async def test_an_unsure_answer_reads_every_file(google_account, case):
    names = {"a": "a" if case == "no hit" else "a wombat paragraph", "b": "b"}
    corpora = await _corpora(google_account, names)
    text = "paragraph" if case == "no query" else "wombat"
    under = ["owned/a.gdoc.json"] if case == "a file scope" else [""]
    clock = None
    if case in ("incomplete", "search fails"):
        # A search that answers learns the query it is asked with.
        await google_account.run.record_requests()
        assert await _ask(google_account, corpora, text, [_scope()])
        (search,) = await google_account.listings()
        if case == "incomplete":
            asked = await google_account.run.call(
                "GET", f"{FILES}?{search.query}"
            )
            body = {**asked, "incompleteSearch": True}
            await google_account.run.answer_next(
                "GET", FILES, 200, body, query=search.query
            )
        else:
            clock = ManualClock()
            await google_account.run.answer_next(
                "GET", FILES, None, times=UNTIL_CLEARED, query=search.query
            )
    scopes = [_scope(u) for u in under]
    assert await _ask(google_account, corpora, text, scopes, clock) is None


@pytest.mark.asyncio
async def test_each_query_is_asked_and_their_answers_joined(google_account):
    corpora = await _corpora(google_account, {"a": "a", "b": "b notes"})
    await google_account.run.record_requests()
    out = await _ask(google_account, corpora, "notes", [_scope("owned")])
    assert out is not None
    assert [p.vfs_path for p in out] == ["owned/b.gdoc.json"]
    assert [text for text, _, _ in await _searched(google_account)] == [
        "notes",
        "otes",
    ]


# Drive could not finish the listing, so it is not the directory, and
# grep's own walk lists it again and may find more.
@pytest.mark.asyncio
async def test_an_unfinished_listing_reads_every_file(google_account):
    corpora = await _corpora(google_account, {"a": "a wombat"})
    manager = google_account.token_manager()
    accessor = GDocsAccessor(config=manager.config, token_manager=manager)
    out = await files_containing(
        accessor,
        _readdir_over(corpora, partial=True),
        MIME,
        DOCS_WORDS,
        "wombat",
        [_scope("owned")],
    )
    assert out is None
