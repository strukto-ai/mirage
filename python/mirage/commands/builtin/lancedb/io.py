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
from mirage.core.lancedb.read import read as _read
from mirage.core.lancedb.readdir import is_dir_name as _is_dir_name
from mirage.core.lancedb.readdir import readdir as _readdir
from mirage.core.lancedb.stat import stat as _stat

# LanceDB rows are read through the generic factory (find walks readdir with
# the is_dir_name hint); search pushes down to the LanceDB query API.
# LanceDB is read-only, so the generic
# byte-mutation commands are intentionally absent (no write op wired). There is
# no native streaming read, so the stream op is synthesized from the whole-row
# read.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    is_dir_name=lambda a, name: _is_dir_name(name, config=a.config),
    local=False,
)

resolve_glob = IO.resolve_glob
