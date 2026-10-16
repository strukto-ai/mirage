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

from mirage.events.payload import event_at, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec

_MAILBOX_CHANGES = frozenset({"EXISTS", "EXPUNGE", "FETCH", "VANISHED"})


class EmailEventHook:
    """Map one IMAP IDLE response onto mount paths.

    The consumer holds the IDLE connection on a mailbox and passes each
    untagged response's name (``EXISTS``, ``EXPUNGE``, ``FETCH`` or
    ``VANISHED``) with ``{"mailbox": <name>}``, the mailbox it selected.
    Nothing here runs a loop.

    A response names a message by its sequence number in the mailbox,
    never by UID, and says nothing of its date, while a message file is
    ``<folder>/<day>/<subject>__<uid>.email.json``. ``EXISTS`` (a message
    arrived), ``EXPUNGE`` and ``VANISHED`` (one left) and ``FETCH`` (its
    flags, which the file renders, changed) therefore name only the
    folder, which is UNKNOWN. The folder is the mailbox's name as the
    server lists it, which is how ``readdir`` names it. ``RECENT`` comes
    with ``EXISTS`` and maps to nothing.
    """

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one untagged response to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The response's name.
            payload (JsonValue): ``{"mailbox": <name>}``.
        """
        mailbox = text_field(payload, "mailbox")
        if event_type.upper() not in _MAILBOX_CHANGES or not mailbox:
            return ()
        return (event_at(root, mailbox, FileChangeKind.UNKNOWN),)
