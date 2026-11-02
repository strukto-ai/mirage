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


from dataclasses import dataclass


@dataclass(frozen=True)
class HistoryEntry:
    """One entry bash's history adds for an input it reads.

    Args:
        text (str): the entry, its lines joined as ``cmdhist`` joins them.
        at (int | None): where its first command starts in the text the
            tree reads; None for a line of blanks.
    """

    text: str
    at: int | None
