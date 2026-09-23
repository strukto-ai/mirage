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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gdocs.client import TokenManager, docs_base, google_get
from mirage.core.gdocs.readdir import readdir
from mirage.core.gdocs.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import compact_json_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent

TABS_CONTENT_PARAM = "true"


async def read_doc(token_manager: TokenManager, doc_id: str) -> bytes:
    """Fetch full document JSON, every tab included.

    `documents.get` fills the singleton fields from the first tab and
    leaves `tabs` empty unless asked otherwise, so without
    `includeTabsContent` a multi-tab document renders as tab 1 and the
    rest are absent rather than truncated. Asking for it moves the
    content under `tabs[]` and leaves `body` empty, which is the shape
    the VFS prompt documents.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        doc_id (str): Google Docs document ID.

    Returns:
        bytes: JSON response as bytes.
    """
    url = f"{docs_base(token_manager)}/documents/{doc_id}"
    data = await google_get(token_manager,
                            url,
                            params={"includeTabsContent": TABS_CONTENT_PARAM})
    return compact_json_bytes(data)


async def _read_file(accessor: GDocsAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    return await read_doc(accessor.token_manager, entry.id)


read = make_read(detect_scope, readers={"file": _read_file})
