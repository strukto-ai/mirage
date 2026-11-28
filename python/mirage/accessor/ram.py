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

import threading

from mirage.accessor.base import Accessor
from mirage.utils.dates import stamp_after
from mirage.vfs.ram.store import RAMStore

# Held across reading a store's last stamp and keeping the next, so two
# threads writing one store never take the same one.
_STAMPING = threading.Lock()


class RAMAccessor(Accessor):
    def __init__(self, store: RAMStore) -> None:
        self.store = store

    def stamped(self) -> int:
        """The time a write lands at, in nanoseconds: now, past every time
        a mount on the store gave a write before."""
        with _STAMPING:
            self.store.stamp = stamp_after(self.store.stamp)
            return self.store.stamp
