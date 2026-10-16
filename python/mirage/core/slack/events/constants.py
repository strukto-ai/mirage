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

CHAT_FILE = "chat.jsonl"
FILES_DIR = "files"

CHANNEL_LIST_EVENTS = frozenset(
    {
        "channel_created",
        "channel_deleted",
        "channel_rename",
        "channel_archive",
        "channel_unarchive",
        "group_deleted",
        "group_rename",
        "group_archive",
        "group_unarchive",
    }
)

DM_LIST_EVENTS = frozenset({"im_created"})

USER_LIST_EVENTS = frozenset({"user_change", "team_join"})

ITEM_EVENTS = frozenset(
    {"reaction_added", "reaction_removed", "pin_added", "pin_removed"}
)
