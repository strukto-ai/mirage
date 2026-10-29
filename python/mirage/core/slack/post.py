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

from typing import Any

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.client import slack_get, slack_post, upload_bytes


async def post_message(
    accessor: SlackAccessor, channel_id: str, text: str
) -> dict[str, Any]:
    """Post a message to a channel.

    Args:
        accessor (SlackAccessor): Slack accessor.
        channel_id (str): channel ID.
        text (str): message text.

    Returns:
        dict: API response.
    """
    return await slack_post(
        accessor, "chat.postMessage", {"channel": channel_id, "text": text}
    )


async def reply_to_thread(
    accessor: SlackAccessor, channel_id: str, thread_ts: str, text: str
) -> dict[str, Any]:
    """Reply to a thread.

    Args:
        accessor (SlackAccessor): Slack accessor.
        channel_id (str): channel ID.
        thread_ts (str): parent message ts.
        text (str): reply text.

    Returns:
        dict: API response.
    """
    return await slack_post(
        accessor,
        "chat.postMessage",
        {"channel": channel_id, "thread_ts": thread_ts, "text": text},
    )


async def upload_file(
    accessor: SlackAccessor,
    channel_id: str,
    filename: str,
    data: bytes,
    initial_comment: str | None = None,
    thread_ts: str | None = None,
) -> dict[str, Any]:
    """Share a file in a channel or thread, the way Slack's own SDKs do:
    ask for an upload URL, send the bytes there, then complete the
    upload into the conversation. The completion is a JSON body, so a
    long ``initial_comment`` never outgrows a request line.

    Args:
        accessor (SlackAccessor): Slack accessor.
        channel_id (str): channel ID.
        filename (str): the file's name in Slack.
        data (bytes): the file's bytes.
        initial_comment (str | None): message text posted with the file.
        thread_ts (str | None): parent message ts, to share in its thread.

    Returns:
        dict: the ``files.completeUploadExternal`` response.
    """
    ticket = await slack_get(
        accessor,
        "files.getUploadURLExternal",
        {"filename": filename, "length": len(data)},
    )
    await upload_bytes(accessor, str(ticket["upload_url"]), data)
    body: dict[str, Any] = {
        "files": [{"id": ticket["file_id"], "title": filename}],
        "channel_id": channel_id,
    }
    if initial_comment:
        body["initial_comment"] = initial_comment
    if thread_ts:
        body["thread_ts"] = thread_ts
    return await slack_post(accessor, "files.completeUploadExternal", body)
