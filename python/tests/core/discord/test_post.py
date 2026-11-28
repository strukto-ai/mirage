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

from mirage.core.discord.post import (
    delete_message,
    edit_message,
    send_message,
    send_poll,
)
from tests.fixtures.discord_guild import DAY, GENERAL, MESSAGE, MESSAGES


@pytest.mark.asyncio
async def test_send_message_posts_content(discord_guild):
    sent = await send_message(discord_guild.accessor(), GENERAL, "hello")
    assert await discord_guild.run.bodies("POST", MESSAGES) == [
        {"content": "hello"}
    ]
    stored = await discord_guild.message(GENERAL, sent["id"])
    assert stored["content"] == "hello"


@pytest.mark.asyncio
async def test_send_message_with_a_file_posts_multipart(discord_guild):
    sent = await send_message(
        discord_guild.accessor(), GENERAL, "", file=("reply.wav", b"RIFF")
    )
    stored = await discord_guild.message(GENERAL, sent["id"])
    [attached] = stored["attachments"]
    assert attached["filename"] == "reply.wav"
    path = attached["url"].split("/attachments/", 1)[1].split("?", 1)[0]
    assert await discord_guild.run.read(f"/attachments/{path}") == b"RIFF"


@pytest.mark.asyncio
async def test_send_message_with_reference(discord_guild):
    [hello, _] = await discord_guild.day(GENERAL, DAY)
    await send_message(discord_guild.accessor(), GENERAL, "re", hello["id"])
    assert await discord_guild.run.bodies("POST", MESSAGES) == [
        {"content": "re", "message_reference": {"message_id": hello["id"]}}
    ]


@pytest.mark.asyncio
async def test_edit_message_patches_content(discord_guild):
    # A bot may edit only what it posted.
    mine = await discord_guild.post(GENERAL, "draft")
    await edit_message(discord_guild.accessor(), GENERAL, mine["id"], "edited")
    assert await discord_guild.run.bodies("PATCH", MESSAGE) == [
        {"content": "edited"}
    ]
    stored = await discord_guild.message(GENERAL, mine["id"])
    assert stored["content"] == "edited"


@pytest.mark.asyncio
async def test_delete_message_deletes(discord_guild):
    mine = await discord_guild.post(GENERAL, "gone soon")
    await delete_message(discord_guild.accessor(), GENERAL, mine["id"])
    assert await discord_guild.count(MESSAGE, "DELETE") == 1
    gone = f"/api/v10/channels/{GENERAL}/messages/{mine['id']}"
    async with discord_guild.run.http.get(discord_guild.run.url + gone) as r:
        assert r.status == 404


@pytest.mark.asyncio
async def test_send_poll_shapes_the_poll_object(discord_guild):
    await send_poll(
        discord_guild.accessor(),
        GENERAL,
        "Lunch?",
        ["Pizza", "Sushi"],
        duration_hours=48,
        multiselect=True,
    )
    assert await discord_guild.run.bodies("POST", MESSAGES) == [
        {
            "poll": {
                "question": {"text": "Lunch?"},
                "answers": [
                    {"poll_media": {"text": "Pizza"}},
                    {"poll_media": {"text": "Sushi"}},
                ],
                "duration": 48,
                "allow_multiselect": True,
            }
        }
    ]
