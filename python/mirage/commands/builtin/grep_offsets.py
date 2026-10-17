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


def prefix_of(
    number: int | None,
    offset: int | None,
    selected: bool = True,
    width: int = 0,
) -> str:
    """grep's line-number and byte-offset fields, in GNU's fixed order.

    GNU prints FILENAME, then LINE NUMBER, then BYTE OFFSET, whatever
    order the flags were given in, and picks the separator once per line:
    a context line renders every field with ``-`` where a selected line
    uses ``:``.

    Args:
        number (int | None): the line number, None when -n is off.
        offset (int | None): the byte offset, None when -b is off.
        selected (bool): False for a context line.
        width (int): the width grep -T pads each number to.
    """
    separator = ":" if selected else "-"
    fields = ""
    if number is not None:
        fields += f"{number:>{width}}{separator}"
    if offset is not None:
        fields += f"{offset:>{width}}{separator}"
    return fields
