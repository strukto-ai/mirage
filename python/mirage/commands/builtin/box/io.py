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
from mirage.core.box.read import read as _read
from mirage.core.box.read import stream as _stream
from mirage.core.box.readdir import is_dir_name as _is_dir_name
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.stat import stat as _stat

# Box is read-only: the generic byte-mutation commands (cp/mv/tee/...) are
# intentionally absent. du keeps a bespoke wrapper (like onedrive/hf)
# because box path->id resolution needs the dispatcher-injected index and
# its du_all follows the flat du_multi contract.
IO = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_stream,
    stat=_stat,
    is_dir_name=lambda _accessor, child: _is_dir_name(child),
    is_mounted=lambda a: True,
    local=False,
)

resolve_glob = IO.resolve_glob
