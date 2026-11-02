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


from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
    from mirage.workspace.history.constants import OPENERS, WORDS
    from mirage.workspace.history.entries import history_entries
    from mirage.workspace.history.line import LineHistory
    from mirage.workspace.history.types import HistoryEntry

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.workspace.history.constants": ("OPENERS", "WORDS"),
    "mirage.workspace.history.entries": ("history_entries",),
    "mirage.workspace.history.line": ("LineHistory",),
    "mirage.workspace.history.types": ("HistoryEntry",),
}

__all__ = [
    "OPENERS",
    "WORDS",
    "HistoryEntry",
    "LineHistory",
    "history_entries",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
