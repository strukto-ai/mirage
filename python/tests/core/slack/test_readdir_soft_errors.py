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

from mirage.core.slack.client import SlackApiError
from mirage.core.slack.read import read
from mirage.core.slack.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.slack import SlackVFS
from tests.fixtures.mounted import Mounted
from tests.fixtures.slack_workspace import HISTORY, SlackWorkspace

CHANNEL = "/slack/channels/random__C2"
DAY = f"{CHANNEL}/2025-11-04"
UNTIL_CLEARED = 1_000_000


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/slack"),
        virtual=virtual,
        directory=virtual + "/",
    )


async def _history_refused(workspace: SlackWorkspace, code: str) -> None:
    # Slack refuses in a 200 body, the way every refusal comes.
    await workspace.run.answer_next(
        "GET",
        HISTORY,
        200,
        {"ok": False, "error": code},
        times=UNTIL_CLEARED,
    )


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
async def test_a_channel_slack_refuses_is_eacces(slack_workspace, code):
    mounted = Mounted(SlackVFS, slack_workspace.accessor(), "/slack")
    await mounted.readdir(_spec("/slack/channels"))
    await _history_refused(slack_workspace, code)
    with pytest.raises(PermissionError) as raised:
        await mounted.readdir(_spec(CHANNEL))
    assert raised.value.filename == CHANNEL


@pytest.mark.asyncio
@pytest.mark.parametrize("below", ["", "/files"])
async def test_a_day_slack_refuses_is_eacces(slack_workspace, below):
    await _history_refused(slack_workspace, "not_in_channel")
    own = FileStat(
        name="files" if below else "2025-11-04",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C2"},
    )
    with pytest.raises(PermissionError) as raised:
        await readdir(slack_workspace.accessor(), _spec(DAY + below), own)
    assert raised.value.filename == DAY + below


@pytest.mark.asyncio
async def test_reading_a_refused_day_is_eacces(slack_workspace):
    await _history_refused(slack_workspace, "not_in_channel")
    chat = f"{DAY}/chat.jsonl"
    day = FileStat(
        name="2025-11-04",
        type=FileType.DIRECTORY,
        extra={"channel_id": "C2"},
    )
    with pytest.raises(PermissionError) as raised:
        await read(slack_workspace.accessor(), _spec(chat), None, day)
    assert raised.value.filename == chat


@pytest.mark.asyncio
async def test_other_slack_errors_propagate(slack_workspace):
    mounted = Mounted(SlackVFS, slack_workspace.accessor(), "/slack")
    await mounted.readdir(_spec("/slack/channels"))
    await _history_refused(slack_workspace, "ratelimited")
    with pytest.raises(SlackApiError, match="ratelimited"):
        await mounted.readdir(_spec(CHANNEL))
