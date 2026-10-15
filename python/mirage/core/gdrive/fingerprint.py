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

from mirage.core.gdrive import NATIVE_RESOURCE_TYPES
from mirage.types import JsonValue


def _token(value: JsonValue) -> str | None:
    return value if isinstance(value, str) and value else None


def drive_fingerprint(
    resource_type: str,
    md5: JsonValue,
    head_revision: JsonValue,
    modified: JsonValue,
) -> str | None:
    """The token a Drive file's stat and read both stamp, chosen by kind.

    Drive gives every file with content an md5 and a head revision. A
    Doc, Sheet or Slides file has neither, so its modified stamp stands
    in: a weaker token, but it errs toward refetching. An absent, empty
    or non-string field is no token, the same on both hosts.

    Args:
        resource_type (str): the file's gdrive resource type.
        md5 (JsonValue): Drive's ``md5Checksum``.
        head_revision (JsonValue): Drive's ``headRevisionId``.
        modified (JsonValue): Drive's ``modifiedTime``.
    """
    if resource_type in NATIVE_RESOURCE_TYPES:
        return _token(modified)
    return _token(md5) or _token(head_revision)
