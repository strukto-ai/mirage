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

from mirage.vfs.types import Effect

DEFAULT_MAX_DU_ENTRIES = 10000

# Every effect that changes the mount: a read-only mount refuses these
# and admission judges them as writes.
WRITE_EFFECTS = frozenset(
    {Effect.WRITE, Effect.CREATE, Effect.REMOVE, Effect.RENAME, Effect.ATTR}
)
