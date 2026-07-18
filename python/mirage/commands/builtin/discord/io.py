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

from mirage.commands.builtin.generic_bind import CommandIO
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.discord.read import read as _read
from mirage.core.discord.readdir import is_dir_name as _is_dir_name
from mirage.core.discord.readdir import readdir as _readdir
from mirage.core.discord.stat import stat as _stat

# Channel history is read through the generic factory (find walks readdir
# with the is_dir_name hint); grep/rg/head are bespoke (channel search
# push-down, history pagination) and writes go through the discord_* commands,
# so the generic byte-mutation commands are absent.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    is_dir_name=lambda a, name: _is_dir_name(name),
    local=False,
)

resolve_glob = IO.resolve_glob
