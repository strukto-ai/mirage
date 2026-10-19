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

from collections.abc import Callable, Sequence

from mirage.types import Visibility
from mirage.view.types import NamespaceLinks
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.types import MountRow


def readers(
    rows: Sequence[MountRow] = (),
    links: NamespaceLinks | None = None,
    visibility: Visibility | None = None,
) -> Callable[[str | None], NamespaceReader]:
    """A namespace's readers over a fixed mount table and link table,
    for files that stand outside a workspace.

    Args:
        rows (Sequence[MountRow]): the registered mounts.
        links (NamespaceLinks | None): the link table, None for none.
        visibility (Visibility | None): every session's visibility.
    """
    return lambda session_id: NamespaceReader(
        links, lambda: list(rows), session_id, lambda: visibility
    )
