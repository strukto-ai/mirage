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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.post import (delete_message, edit_message,
                                      send_message, send_poll)

CONFIG = DiscordConfig(token="bot-token")


@pytest.mark.asyncio
async def test_send_message_posts_content():
    with patch("mirage.core.discord.post.discord_post",
               new_callable=AsyncMock,
               return_value={"id": "M1"}) as post:
        await send_message(CONFIG, "C1", "hello")
    post.assert_awaited_once_with(CONFIG, "/channels/C1/messages",
                                  {"content": "hello"})


@pytest.mark.asyncio
async def test_send_message_with_reference():
    with patch("mirage.core.discord.post.discord_post",
               new_callable=AsyncMock,
               return_value={"id": "M2"}) as post:
        await send_message(CONFIG, "C1", "re", "M1")
    post.assert_awaited_once_with(CONFIG, "/channels/C1/messages", {
        "content": "re",
        "message_reference": {
            "message_id": "M1"
        },
    })


@pytest.mark.asyncio
async def test_edit_message_patches_content():
    with patch("mirage.core.discord.post.discord_patch",
               new_callable=AsyncMock,
               return_value={"id": "M1"}) as patch_fn:
        await edit_message(CONFIG, "C1", "M1", "edited")
    patch_fn.assert_awaited_once_with(CONFIG, "/channels/C1/messages/M1",
                                      {"content": "edited"})


@pytest.mark.asyncio
async def test_delete_message_deletes():
    with patch("mirage.core.discord.post.discord_delete",
               new_callable=AsyncMock) as delete_fn:
        await delete_message(CONFIG, "C1", "M1")
    delete_fn.assert_awaited_once_with(CONFIG, "/channels/C1/messages/M1")


@pytest.mark.asyncio
async def test_send_poll_shapes_the_poll_object():
    with patch("mirage.core.discord.post.discord_post",
               new_callable=AsyncMock,
               return_value={"id": "M3"}) as post:
        await send_poll(CONFIG,
                        "C1",
                        "Lunch?", ["Pizza", "Sushi"],
                        duration_hours=48,
                        multiselect=True)
    body = post.await_args.args[2]
    assert body == {
        "poll": {
            "question": {
                "text": "Lunch?"
            },
            "answers": [
                {
                    "poll_media": {
                        "text": "Pizza"
                    }
                },
                {
                    "poll_media": {
                        "text": "Sushi"
                    }
                },
            ],
            "duration":
            48,
            "allow_multiselect":
            True,
        }
    }
