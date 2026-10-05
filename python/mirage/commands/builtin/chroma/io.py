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

from mirage.core.chroma.read import read as _read
from mirage.core.chroma.read import read_stream as _read_stream
from mirage.core.chroma.search import search_many, search_resource
from mirage.core.chroma.stat import stat as _stat
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import NativeReadOps, ReadOps, SearchOps

# Chroma records are read through the generic factory; find normalises paths,
# search pushes down to the Chroma query API, so the two stay bespoke.
# Chroma is read-only, so the generic byte-mutation commands are
# intentionally absent (no write op wired).
IO = VFSAdapter(
    search=SearchOps(search=search_resource, search_many=search_many),
    read=ReadOps(readdir=CHROMA_TREE.readdir, read_bytes=_read, stat=_stat),
    native=NativeReadOps(read_stream=_read_stream),
    is_mounted=lambda a: True,
    local=False,
).to_command_io()
