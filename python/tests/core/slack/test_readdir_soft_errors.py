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

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.client import SlackApiError
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.read import read
from mirage.core.slack.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.slack import SlackVFS
from tests.fixtures.mounted import Mounted

CHANNEL = "/slack/channels/private__C_INACCESSIBLE"
DAY = f"{CHANNEL}/2026-05-10"


@pytest.fixture
def accessor():
    return SlackAccessor(SlackConfig(token="xoxb-test"))


def _refused(code: str) -> SlackApiError:
    return SlackApiError(
        f"Slack API error (conversations.history): {code}", slack_error=code
    )


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/slack"),
        virtual=virtual,
        directory=virtual + "/",
    )


def _history_fails(err: SlackApiError):
    channels_page = {
        "channels": [
            {"id": "C_INACCESSIBLE", "name": "private", "created": 1}
        ],
        "response_metadata": {"next_cursor": ""},
    }

    async def fake_get(_accessor, method, params=None):
        if method == "conversations.list":
            return channels_page
        if method == "conversations.history":
            raise err
        raise AssertionError(f"unexpected {method}")

    return fake_get


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code",
    [
        "not_in_channel",
        "channel_not_found",
        "missing_scope",
        "is_archived",
        "not_authed",
    ],
)
async def test_a_channel_slack_refuses_is_eacces(accessor, code):
    fake_get = _history_fails(_refused(code))
    mounted = Mounted(SlackVFS, accessor, "/slack")
    with (
        patch("mirage.core.slack.paginate.slack_get", new=fake_get),
        patch("mirage.core.slack.readdir.slack_get", new=fake_get),
    ):
        await mounted.readdir(_spec("/slack/channels"))
        with pytest.raises(PermissionError) as raised:
            await mounted.readdir(_spec(CHANNEL))
    assert raised.value.filename == CHANNEL


@pytest.mark.asyncio
@pytest.mark.parametrize("below", ["", "/files"])
async def test_a_day_slack_refuses_is_eacces(accessor, below):
    async def fake_history(_accessor, channel_id, date_str, _scope):
        raise _refused("not_in_channel")

    own = FileStat(
        name="files" if below else "2026-05-10",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C_INACCESSIBLE"},
    )
    with patch(
        "mirage.core.slack.readdir.fetch_messages_for_day", new=fake_history
    ):
        with pytest.raises(PermissionError) as raised:
            await readdir(accessor, _spec(DAY + below), own)
    assert raised.value.filename == DAY + below


@pytest.mark.asyncio
async def test_reading_a_refused_day_is_eacces(accessor):
    chat = f"{DAY}/chat.jsonl"
    day = FileStat(
        name="2026-05-10",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C_INACCESSIBLE"},
    )
    with patch(
        "mirage.core.slack.read.get_history_jsonl",
        new=AsyncMock(side_effect=_refused("not_in_channel")),
    ):
        with pytest.raises(PermissionError) as raised:
            await read(accessor, _spec(chat), None, day)
    assert raised.value.filename == chat


@pytest.mark.asyncio
async def test_other_slack_errors_propagate(accessor):
    fake_get = _history_fails(_refused("ratelimited"))
    mounted = Mounted(SlackVFS, accessor, "/slack")
    with (
        patch("mirage.core.slack.paginate.slack_get", new=fake_get),
        patch("mirage.core.slack.readdir.slack_get", new=fake_get),
    ):
        await mounted.readdir(_spec("/slack/channels"))
        with pytest.raises(SlackApiError, match="ratelimited"):
            await mounted.readdir(_spec(CHANNEL))
