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

from collections.abc import Sequence


def format_records(records: Sequence[str]) -> bytes:
    if not records:
        return b""
    return ("\n".join(records) + "\n").encode()


def format_optional_records(records: Sequence[str]) -> bytes | None:
    output = format_records(records)
    return output if output else None


def format_record_text(records: Sequence[str]) -> str:
    if not records:
        return ""
    return "\n".join(records) + "\n"


__all__ = ["format_optional_records", "format_record_text", "format_records"]
