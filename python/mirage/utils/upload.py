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

import logging
from collections.abc import Callable
from typing import Any

from mirage.types import FileStat, JsonValue

logger = logging.getLogger(__name__)


def upload_token(
    item: JsonValue,
    stat_of: Callable[[dict[str, Any]], FileStat],
    virtual: str,
) -> str | None:
    """The token an upload reply names for the stored file, or None.

    ``stat_of`` is the backend's own stat parser, so the write's token is
    the kind its ``stat`` reports. The upload has landed by now, so a
    reply that is not an object, or that the parser cannot read, answers
    None instead of raising.

    Args:
        item (JsonValue): the stored file's metadata from the reply.
        stat_of (Callable[[dict[str, Any]], FileStat]): the backend's stat
            parser for that metadata.
        virtual (str): the written path, for the debug log.
    """
    if not isinstance(item, dict):
        return None
    try:
        return stat_of(item).fingerprint or None
    except Exception as exc:
        logger.debug("unreadable upload reply for %s: %s", virtual, exc)
        return None
