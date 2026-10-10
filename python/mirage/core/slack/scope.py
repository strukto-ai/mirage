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

from mirage.core.hierarchy.codec import DATE, JSON_NAME, Codec
from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType


def is_container(text: str) -> bool:
    """Whether a segment names a message container.

    Args:
        text (str): decoded segment payload.
    """
    return text in ("channels", "dms")


# Channels and DMs share every level below the container, so the
# container is a validated slot rather than two parallel scope families;
# the decoded value rides the slots the way an id does.
CONTAINER = Codec(validate=is_container)

_CHANNEL = (Slot("container", CONTAINER), Slot("channel", id_key="channel_id"))
_DAY = _CHANNEL + (Slot("day", DATE),)

# One description of the tree: readdir, stat, read and search all
# classify through it, so the file surface and the command surface
# cannot disagree about what a path means.
SCOPES = (
    Scope(kind="channels_root", segments=("channels",), probed=False),
    Scope(kind="dms_root", segments=("dms",), probed=False),
    Scope(kind="users_root", segments=("users",), probed=False),
    Scope(
        kind="user",
        segments=("users", Slot("user", JSON_NAME, id_key="user_id")),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(kind="channel", segments=_CHANNEL),
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
