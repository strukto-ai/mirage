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

DISCORD_API = "https://discord.com/api/v10"
MAX_RETRIES = 3

CHAT_FILE = "chat.jsonl"
FILES_DIR = "files"
THREAD_TYPES = frozenset({10, 11, 12})

MESSAGE_EVENTS = frozenset(
    {"MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE"}
)
REACTION_EVENTS = frozenset(
    {
        "MESSAGE_REACTION_ADD",
        "MESSAGE_REACTION_REMOVE",
        "MESSAGE_REACTION_REMOVE_ALL",
        "MESSAGE_REACTION_REMOVE_EMOJI",
    }
)
CHANNEL_EVENTS = frozenset(
    {"CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"}
)
MEMBER_EVENTS = frozenset(
    {"GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE"}
)
GUILD_EVENTS = frozenset({"GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"})
