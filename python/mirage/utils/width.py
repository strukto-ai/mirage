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

from mirage.rs.stream import open_stream


def text_width(text: str) -> int:
    """The summed terminal columns of text, using Rust's Unicode table.

    Shares the pinned C.UTF-8 widths of wc, fold and column. Controls
    and unassigned characters take no column; this does not interpret
    cursor movement. Lone surrogates representing raw filename bytes
    retain one column each.

    Args:
        text (str): the characters to measure.
    """
    return int(
        open_stream("width", {"text": [ord(ch) for ch in text]}).finish()
    )
