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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.email.readdir import _msg_filename
from mirage.core.email.search import (
    _build_vfs_path,
    build_search_criteria,
    files_containing,
)
from mirage.types import PathSpec
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length

CJK_SUBJECT = "会議の記録" * 40


def test_a_hit_names_the_file_readdir_created():
    # Composed here from a bare `_sanitize`, a hit pointed at a path that
    # does not exist as soon as the subject was long enough to be trimmed:
    # readdir budgets the subject against the uid and the suffix, and this
    # did not, so the two names differed.
    msg = {
        "subject": CJK_SUBJECT,
        "uid": "7",
        "date": "Mon, 5 Jan 2026 10:00:00 +0000",
    }
    path = _build_vfs_path("/mail", "INBOX", msg)
    assert path.endswith("/" + _msg_filename(CJK_SUBJECT, "7"))


def test_a_hits_filename_fits_name_max():
    msg = {
        "subject": CJK_SUBJECT,
        "uid": "7",
        "date": "Mon, 5 Jan 2026 10:00:00 +0000",
    }
    name = _build_vfs_path("/mail", "INBOX", msg).rsplit("/", 1)[-1]
    assert byte_length(name) <= NAME_MAX_BYTES
    assert "\ufffd" not in name


def test_search_criteria_escape_quotes_and_backslashes():
    # A grep pattern holding a quote used to end the quoted string early, so
    # the rest of the pattern was read as IMAP search keys (#1067).
    assert build_search_criteria(text='say "hi"') == 'TEXT "say \\"hi\\""'
    assert build_search_criteria(subject="a\\b") == 'SUBJECT "a\\\\b"'
    assert (
        build_search_criteria(from_addr='"Al" <a@x>')
        == 'FROM "\\"Al\\" <a@x>"'
    )
    assert build_search_criteria(to_addr='x"y') == 'TO "x\\"y"'


def test_search_criteria_keep_spaces_and_unicode():
    assert (
        build_search_criteria(text="quarterly review")
        == 'TEXT "quarterly review"'
    )
    cjk = "会議の記録"
    assert build_search_criteria(subject=cjk) == f'SUBJECT "{cjk}"'


def test_search_criteria_join_keys_and_leave_dates_bare():
    assert build_search_criteria() == "ALL"
    assert (
        build_search_criteria(
            unseen=True, since="05-Jan-2026", before="07-Jan-2026"
        )
        == "UNSEEN SINCE 05-Jan-2026 BEFORE 07-Jan-2026"
    )


ACCESSOR = SimpleNamespace(config=SimpleNamespace(max_messages=200))
HEADERS = [
    {
        "uid": "3",
        "subject": "Q2 Budget",
        "date": "Mon, 5 Jan 2026 10:00 +0000",
    },
    {
        "uid": "9",
        "subject": "",
        "date": "",
        "internal_date": "06-Jan-2026 09:30:00 +0000",
    },
]


def _scope(key: str) -> PathSpec:
    return PathSpec.from_str_path("/mail" + key, key.lstrip("/"))


async def _ask(text: str, key: str = "/INBOX", whole_word: bool = False):
    uids = AsyncMock(return_value=["3", "9"])
    named = AsyncMock(return_value=HEADERS)
    with (
        patch("mirage.core.email.search.list_message_uids", uids),
        patch("mirage.core.email.search.fetch_headers", named),
    ):
        hits = await files_containing(
            ACCESSOR, text, [_scope(key)], whole_word
        )
    return hits, uids, named


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["/INBOX", "/INBOX/2026-01-05"])
async def test_a_hit_is_the_file_the_folder_lists(key):
    # A day is asked for its whole folder; hits on other days are never
    # walked, so naming them costs nothing.
    hits, uids, named = await _ask("budget", key)
    assert [hit.virtual for hit in hits] == [
        "/mail/INBOX/2026-01-05/Q2_Budget__3.email.json",
        "/mail/INBOX/2026-01-06/No_Subject__9.email.json",
    ]
    assert uids.await_args.args[1:] == ("INBOX", 'TEXT "udget"')
    assert named.await_args.kwargs == {"header_only": True}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, key",
    [
        ("budget", ""),
        ("budget", "/INBOX/2026-01-05/Q2_Budget__3.email.json"),
        ("subject", "/INBOX"),
        ("seen", "/INBOX"),
        ("deploy 42", "/INBOX"),
    ],
)
async def test_a_scope_or_text_imap_cannot_vouch_for_is_not_asked(text, key):
    hits, uids, _ = await _ask(text, key)
    assert hits is None
    uids.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_failed_search_is_no_answer_and_no_hit_is_one():
    failed = AsyncMock(side_effect=ValueError("IMAP rejected the search"))
    with patch("mirage.core.email.search.list_message_uids", failed):
        assert (
            await files_containing(
                ACCESSOR, "budget", [_scope("/INBOX")], False
            )
            is None
        )
    empty = AsyncMock(return_value=[])
    with (
        patch("mirage.core.email.search.list_message_uids", empty),
        patch(
            "mirage.core.email.search.fetch_headers",
            AsyncMock(return_value=[]),
        ),
    ):
        assert (
            await files_containing(
                ACCESSOR, "budget", [_scope("/INBOX")], False
            )
            == []
        )


@pytest.mark.asyncio
async def test_more_matches_than_a_folder_lists_is_no_answer():
    # The search keeps the newest matches; past max_messages it leaves out
    # older ones a cached listing may still hold, so it cannot rule out.
    many = AsyncMock(return_value=[str(uid) for uid in range(201)])
    with patch("mirage.core.email.search.list_message_uids", many):
        assert (
            await files_containing(
                ACCESSOR, "budget", [_scope("/INBOX")], False
            )
            is None
        )
    assert many.await_args.kwargs["max_results"] == 201
