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

import pytest

from tests.fixtures.gmail_api import FakeGmail


# The listing keeps each message's rendered text, so a message is read when
# its text holds the word anywhere: e5 holds rtf only in its attachment's
# MIME type, g7 travel only in a snippet cut inside traveler, i9 mountain
# only in its Date header and j10 wombat only inside a link, which Gmail's
# search may not split out. Gmail's search is never asked.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, reads",
    [
        ("grep -rlw deploy /gmail", ["b2", "b2", "c3"]),
        ("grep -rl deploy /gmail", ["b2", "b2", "c3"]),
        ("grep -rlw Ana /gmail/INBOX", ["a1"]),
        ("grep -rlw plan /gmail/INBOX", ["a1"]),
        ("grep -rlw deploy /gmail/INBOX/2026-01-06", ["b2"]),
        ("rg -lw friday /gmail/Work", ["b2"]),
        ("grep -rlw rtf /gmail/INBOX", ["e5", "f6"]),
        ("grep -rlw travel /gmail/INBOX", ["a1", "g7"]),
        ("grep -rlw mountain /gmail/INBOX", ["h8", "i9"]),
        ("grep -rlw wombat /gmail", ["j10"]),
        ("grep -rlw nothing /gmail", []),
    ],
)
async def test_only_the_messages_whose_text_holds_it_are_read(
    gmail, line, reads
):
    full = await gmail(line, content_search=False)
    out, code, read, searches = await gmail(line)
    assert (out, code) == full[:2]
    assert read == reads
    assert searches == []


# A message's labels change after the listing kept its text, so the kept
# text leaves them out and a text that may lie in a labels field reads
# every message.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "grep -rl inbox /gmail",
        "grep -rlw STARRED /gmail",
        "grep -rl Label_1 /gmail",
        "grep -rl abel /gmail",
        "grep -rlF '\",\"' /gmail",
    ],
)
async def test_a_text_a_label_may_hold_reads_every_message(gmail, line):
    full = await gmail(line, content_search=False)
    assert (await gmail(line))[:3] == full[:3]


@pytest.mark.asyncio
async def test_every_message_is_read_for_a_text_that_is_not_ascii(gmail):
    line = "grep -rl caf\u00e9 /gmail"
    full = await gmail(line, content_search=False)
    assert (await gmail(line, FakeGmail()))[:3] == full[:3]
