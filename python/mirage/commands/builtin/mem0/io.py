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

from mirage.commands.builtin.generic_bind import CommandIO
from mirage.core.mem0.read import read as _read
from mirage.core.mem0.read import read_stream as _read_stream
from mirage.core.mem0.readdir import readdir as _readdir
from mirage.core.mem0.stat import stat as _stat

IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda _accessor: True,
    local=False,
)

resolve_glob = IO.resolve_glob
