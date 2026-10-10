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

import asyncio

import aiohttp
import pytest

from tests.core.gmail.conftest import RATE_LIMITED, FakeGmail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, reads",
    [
        ("grep -rlw deploy /gmail", ["b2", "b2", "c3"]),
        ("grep -rlw Ana /gmail/INBOX", ["a1"]),
        ("grep -rlw plan /gmail/INBOX", ["a1"]),
        ("grep -rlw deploy /gmail/INBOX/2026-01-06", ["b2"]),
        ("rg -lw friday /gmail/Work", ["b2"]),
    ],
)
async def test_a_word_reads_only_the_messages_search_names(gmail, line, reads):
    full = await gmail(line, content_search=False)
    out, code, read, _ = await gmail(line)
    assert (out, code) == full[:2]
    assert read == reads


@pytest.mark.asyncio
async def test_a_label_day_is_searched_within_its_bounds(gmail):
    *_, searches = await gmail("grep -rlw deploy /gmail/INBOX/2026-01-06")
    assert searches == [
        "deploy after:1767657599 before:1767744000",
        "eploy after:1767657599 before:1767744000",
        "filename:deploy after:1767657599 before:1767744000",
        "filename:eploy after:1767657599 before:1767744000",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, fake",
    [
        ("grep -rlw inbox /gmail", FakeGmail()),
        ("grep -rlw Jan /gmail", FakeGmail()),
        ("grep -rlw nothing /gmail", FakeGmail()),
        ("grep -rlw deploy /gmail", FakeGmail(fails=RATE_LIMITED)),
        (
            "grep -rlw deploy /gmail",
            FakeGmail(fails=aiohttp.ClientConnectionError("reset")),
        ),
        ("grep -rlw deploy /gmail", FakeGmail(fails=asyncio.TimeoutError())),
        ("grep -rlw deploy /gmail", FakeGmail(more=True)),
    ],
)
async def test_every_message_is_read_when_search_cannot_answer(
    gmail, line, fake
):
    full = await gmail(line, content_search=False)
    out, code, read, _ = await gmail(line, fake)
    assert (out, code, read) == full[:3]
