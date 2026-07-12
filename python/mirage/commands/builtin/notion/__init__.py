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

from functools import partial

from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.notion.notion_block_append import \
    notion_block_append
from mirage.commands.builtin.notion.notion_comment_add import \
    notion_comment_add
from mirage.commands.builtin.notion.notion_page_create import \
    notion_page_create
from mirage.commands.builtin.notion.notion_search import notion_search
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.notion.find import find as _find
from mirage.core.notion.read import read as _read
from mirage.core.notion.readdir import readdir as _readdir
from mirage.core.notion.stat import stat as _stat

# Notion pages/databases are read through the generic factory; writes go
# through the bespoke notion_* commands, so the generic byte-mutation commands
# are intentionally absent (no write op wired).
_NOTION_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
    find=_find,
)

COMMANDS = [
    *make_generic_commands(
        "notion",
        _NOTION_CMD_OPS,
    ),
    notion_block_append,
    notion_comment_add,
    notion_page_create,
    notion_search,
]
