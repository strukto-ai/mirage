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

# The byte-order marks, each with the encoding it names.
BOMS = (
    (b"\xef\xbb\xbf", "UTF-8"),
    (b"\xff\xfe", "UTF-16LE"),
    (b"\xfe\xff", "UTF-16BE"),
)


def bom_of(data: bytes) -> tuple[bytes, str] | None:
    """The byte-order mark ``data`` starts with and the encoding it names.

    Args:
        data (bytes): the first bytes of a stream, three or all of them.
    """
    for mark, name in BOMS:
        if data.startswith(mark):
            return mark, name
    return None
