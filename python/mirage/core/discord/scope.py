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

from mirage.core.hierarchy.codec import DATE, JSON_NAME
from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType

_GUILD = (Slot("guild", id_key="guild_id"),)
_CHANNEL = _GUILD + ("channels", Slot("channel", id_key="channel_id"))
_DAY = _CHANNEL + (Slot("day", DATE),)

# One description of the tree: readdir, stat, read and the search
# push-down all classify through it, so the file surface and the command
# surface cannot disagree about what a path means. Every dynamic level
# is a `name__id` dirname the tree itself mints, so the ids decode from
# the path and detection needs no index or network round-trip.
SCOPES = (
    Scope(kind="guild", segments=_GUILD),
    Scope(kind="channels_dir", segments=_GUILD + ("channels",)),
    Scope(kind="members_dir", segments=_GUILD + ("members",)),
    Scope(kind="channel", segments=_CHANNEL),
    Scope(
        kind="member",
        segments=_GUILD
        + ("members", Slot("member", JSON_NAME, id_key="user_id")),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(kind="day", segments=_DAY),
    Scope(
        kind="messages",
        segments=_DAY + ("chat.jsonl",),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
    Scope(kind="files", segments=_DAY + ("files",)),
    Scope(
        kind="file_blob", segments=_DAY + ("files", Slot("blob")), leaf=True
    ),
)

detect_scope = make_detect_scope(SCOPES)

# Kinds the guild search push-down may answer for. A day, its chat.jsonl
# and its files are deliberately absent: `search_guild` takes a channel
# but no date, so serving one day from a channel-wide search would report
# messages the line did not ask for. Same doctrine for `file_blob` and
# `member`, whose bytes the message search does not carry.
NATIVE_KINDS = frozenset({"guild", "channels_dir", "channel"})
