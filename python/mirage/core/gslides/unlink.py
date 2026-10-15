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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.core.google.drive import delete_file
from mirage.core.gslides.scope import detect_scope
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.unlink import make_unlink
from mirage.types import FileStat


async def _delete(
    accessor: GSlidesAccessor, match: ScopeMatch, entry: FileStat
) -> None:
    await delete_file(accessor.token_manager, match.slots["file_id"])


unlink = make_unlink(detect_scope, deleters={"file": _delete})
