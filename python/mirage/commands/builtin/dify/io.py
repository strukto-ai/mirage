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

from mirage.core.dify.read import read as _read
from mirage.core.dify.read import read_stream as _read_stream
from mirage.core.dify.search import search_many, search_resource
from mirage.core.dify.stat import stat as _stat
from mirage.core.dify.tree import DIFY_TREE
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import NativeReadOps, ReadOps, SearchOps

# Dify knowledge-base documents are read through the generic factory. stat is
# the full document-detail stat; the commands that would multiply that
# per-entry API call stay cheap through lighter routes instead (ls receives a
# light-stat adapter from the package factory, the find wrapper stats through
# stat_light unless a time test needs detail timestamps). search pushes down
# to the Dify retrieval API. Dify is read-only, so the generic byte-mutation
# commands are intentionally absent (no write op wired).
IO = VFSAdapter(
    search=SearchOps(search=search_resource, search_many=search_many),
    read=ReadOps(readdir=DIFY_TREE.readdir, read_bytes=_read, stat=_stat),
    native=NativeReadOps(read_range=_read, read_stream=_read_stream),
    is_mounted=lambda a: True,
    local=False,
).to_command_io()
