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
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.readdir import _latest_message_ts, _list_files, readdir
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.slack import SlackVFS
from tests.fixtures.mounted import Mounted


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test")


@pytest.mark.asyncio
async def test_latest_message_ts_returns_none_on_not_in_channel(config):
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel"
    )
    with patch(
        "mirage.core.slack.readdir.slack_get", new=AsyncMock(side_effect=err)
    ):
        result = await _latest_message_ts(config, "C_INACCESSIBLE")
    assert result is None


@pytest.mark.asyncio
async def test_latest_message_ts_returns_none_on_missing_scope(config):
    err = RuntimeError(
        "Slack API error (conversations.history): missing_scope "
        "(needed: channels:history; provided: channels:read)"
    )
    with patch(
        "mirage.core.slack.readdir.slack_get", new=AsyncMock(side_effect=err)
    ):
        result = await _latest_message_ts(config, "C_NO_SCOPE")
    assert result is None


@pytest.mark.asyncio
async def test_latest_message_ts_reraises_unrelated_errors(config):
    err = RuntimeError("Slack API error (conversations.history): rate_limited")
    with patch(
        "mirage.core.slack.readdir.slack_get", new=AsyncMock(side_effect=err)
    ):
        with pytest.raises(RuntimeError, match="rate_limited"):
            await _latest_message_ts(config, "C1")


@pytest.mark.asyncio
async def test_day_listing_seals_empty_dir_on_not_in_channel(config):
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel"
    )
    accessor = SlackAccessor(config=config)
    channels_page = {
        "channels": [{"id": "C_INACCESSIBLE", "name": "foo", "created": 1}],
        "response_metadata": {"next_cursor": ""},
    }

    async def fake_get(_cfg, method, params=None, token=None, session=None):
        if method == "conversations.list":
            return channels_page
        if method == "conversations.history":
            raise err
        raise AssertionError(f"unexpected {method}")

    async def fake_history(_cfg, channel_id, date_str, _scope, session=None):
        raise err

    day = "/slack/channels/foo__C_INACCESSIBLE/2026-05-10"
    with (
        patch("mirage.core.slack.paginate.slack_get", new=fake_get),
        patch("mirage.core.slack.readdir.slack_get", new=fake_get),
        patch(
            "mirage.core.slack.readdir.fetch_messages_for_day",
            new=fake_history,
        ),
    ):
        names = await Mounted(SlackVFS, accessor, "/slack").readdir(
            PathSpec(
                vfs_path=mount_key(day, "/slack"), virtual=day, directory=day
            )
        )
    assert names == []


@pytest.mark.asyncio
async def test_readdir_channel_inaccessible_yields_no_dates(config):
    """Full integration: ls /slack/channels/inaccessible/ → no dates."""
    accessor = SlackAccessor(config=config)
    channels_page = {
        "channels": [
            {"id": "C_INACCESSIBLE", "name": "private", "created": 1}
        ],
        "response_metadata": {"next_cursor": ""},
    }
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel"
    )

    async def fake_get(_cfg, method, params=None, token=None, session=None):
        if method == "conversations.list":
            return channels_page
        if method == "conversations.history":
            raise err
        raise AssertionError(f"unexpected {method}")

    mounted = Mounted(SlackVFS, accessor, "/slack")
    with (
        patch("mirage.core.slack.paginate.slack_get", new=fake_get),
        patch("mirage.core.slack.readdir.slack_get", new=fake_get),
    ):
        await mounted.readdir(
            PathSpec(
                vfs_path=mount_key("/slack/channels", "/slack"),
                virtual="/slack/channels",
                directory="/slack/channels/",
            )
        )
        dates = await mounted.readdir(
            PathSpec(
                vfs_path=mount_key(
                    "/slack/channels/private__C_INACCESSIBLE", "/slack"
                ),
                virtual="/slack/channels/private__C_INACCESSIBLE",
                directory="/slack/channels/private__C_INACCESSIBLE/",
            )
        )
    assert dates == []


@pytest.mark.asyncio
async def test_a_soft_error_day_is_a_window(config):
    # An empty day from not_in_channel is not the backend saying the day's
    # messages are gone, so it must not evict what an earlier listing held.
    err = RuntimeError(
        "Slack API error (conversations.history): not_in_channel"
    )
    accessor = SlackAccessor(config=config)
    channels_page = {
        "channels": [{"id": "C_INACCESSIBLE", "name": "foo", "created": 1}],
        "response_metadata": {"next_cursor": ""},
    }

    async def fake_get(_cfg, method, params=None, token=None, session=None):
        return channels_page

    async def fake_history(_cfg, channel_id, date_str, _scope, session=None):
        raise err

    day = "/slack/channels/foo__C_INACCESSIBLE/2026-05-10"
    own = FileStat(
        name="2026-05-10",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C_INACCESSIBLE"},
    )
    with (
        patch("mirage.core.slack.paginate.slack_get", new=fake_get),
        patch(
            "mirage.core.slack.readdir.fetch_messages_for_day",
            new=fake_history,
        ),
    ):
        listing = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key(day, "/slack"), virtual=day, directory=day
            ),
            own,
        )
    assert listing.window is True


async def _soft_day_listing(_accessor, _channel_id, _day):
    return DirListing(entries=[], window=True)


@pytest.mark.asyncio
async def test_a_soft_error_files_listing_is_a_window_too(config):
    # Reached when the files listing was evicted but the day survived; a
    # soft error there must not evict the attachments it listed before.
    accessor = SlackAccessor(config=config)
    own = FileStat(
        name="files", type=FileType.DIRECTORY, extra={"channel_id": "C1"}
    )

    match = ScopeMatch(
        kind="files",
        vfs_path="channels/c__C1/2026-05-10/files",
        slots={"day": "2026-05-10"},
    )
    with patch(
        "mirage.core.slack.readdir._day_listing", new=_soft_day_listing
    ):
        listing = await _list_files(accessor, match, own)
    assert listing.window is True
