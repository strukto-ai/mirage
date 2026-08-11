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

from typing import Protocol

from mirage.runtime.types import PrefixSource
from mirage.utils.path import owner_prefix


class MountResolver(Protocol):
    """Routing questions about the workspace mount table.

    What a runtime holds instead of a flat prefix listing: the two
    questions routing ever asks (what mounts exist, which one owns a
    path), answered by whoever owns the table so a consumer never
    re-implements the longest-prefix rule. Answers use the table's own
    prefix spelling; a surface with a spelling convention of its own
    (``RuntimeVFS``) re-spells on its side of the seam.
    """

    def prefixes(self) -> list[str]:
        """The live mount prefixes, in the table's own spelling."""
        ...

    def owner_of(self, path: str) -> str | None:
        """The prefix owning ``path`` by longest match, or None."""
        ...


class PrefixResolver:
    """A MountResolver over a live prefix listing.

    The one concrete resolver: the workspace wraps whatever view it
    wants a consumer to have (all mounts for the ops facade, a
    sandbox-filtered list for the runtimes) and the matching rule stays
    ``owner_prefix``'s. Reads the source per call, so mounts added or
    removed after construction are always picked up.

    Args:
        source (PrefixSource): live prefix listing, read per call.
    """

    def __init__(self, source: PrefixSource) -> None:
        self._source = source

    def prefixes(self) -> list[str]:
        return list(self._source())

    def owner_of(self, path: str) -> str | None:
        return owner_prefix(self._source(), path)
