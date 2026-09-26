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

from mirage.core.hierarchy.search import make_search_op
from mirage.core.mongodb.read import read as _read
from mirage.core.mongodb.read import stream_any as _read_stream
from mirage.core.mongodb.readdir import readdir as _readdir
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.search import SEARCHERS
from mirage.core.mongodb.stat import stat as _stat
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import NativeReadOps, ReadOps, SearchOps

IO = VFSAdapter(search=SearchOps(
    search=make_search_op(detect_scope, SEARCHERS, _stat),
    meta={"grep": {
        "mode": "regex",
        "stream": True
    }}),
                read=ReadOps(readdir=_readdir, read_bytes=_read, stat=_stat),
                native=NativeReadOps(read_stream=_read_stream),
                is_mounted=lambda a: True,
                local=False).to_command_io()

resolve_glob = IO.resolve_glob
