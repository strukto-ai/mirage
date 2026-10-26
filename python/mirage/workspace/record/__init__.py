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
"""Keyed-record persistence, one tier below the stores that use it.

Sessions, the namespace node table and workspace metadata are three
different tables that happen to persist the same way: a named JSON
record per key, with a generation-CAS write. The client is that
substrate and nothing more, so it lives here rather than inside any one
of them; before this it lived in the session package and the other two
imported upward into it, which made sessions read as foundational to
namespaces and workspace state when the three are peers.

The node table and the session table share one store type,
``NamespaceStore``; workspace metadata keeps its own record. The tables
stay apart where it matters: nodes write through per op and last writer
wins, a session flushes once per line under a generation CAS, the disk
layout is one file for the nodes and one file per session, and only
the session table may live on S3.
"""

from mirage.workspace.record.types import (
    CAS_MAX_RETRIES,
    RecordFields,
    generation_of,
)

__all__ = [
    "CAS_MAX_RETRIES",
    "RecordFields",
    "generation_of",
]
