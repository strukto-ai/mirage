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
from typing import Any, Protocol

from mirage.core.gmail import history, labels, messages
from mirage.core.google.client import TokenManager


class GmailApi(Protocol):
    """Every Gmail request the gmail backend makes, as one object.

    A core op reaches Gmail only through ``GmailAccessor.gmail``, so the
    backend runs against an in-memory mailbox wherever another
    implementation is served there.
    """

    async def list_labels(self) -> list[dict[str, Any]]: ...

    async def list_messages(
        self,
        label_id: str | None = None,
        query: str | None = None,
        max_results: int = 50,
    ) -> list[dict[str, Any]]: ...

    async def get_message_raw(self, message_id: str) -> dict[str, Any]: ...

    async def get_attachment(
        self, message_id: str, attachment_id: str
    ) -> bytes: ...

    async def current_history_id(self) -> str: ...

    async def list_history(
        self, start: str
    ) -> tuple[list[dict[str, Any]], str]: ...


@dataclass(frozen=True, slots=True)
class GmailClient:
    """The live ``GmailApi``: one token manager, one wire call per
    method."""

    token_manager: TokenManager

    async def list_labels(self) -> list[dict[str, Any]]:
        return await labels.list_labels(self.token_manager)

    async def list_messages(
        self,
        label_id: str | None = None,
        query: str | None = None,
        max_results: int = 50,
    ) -> list[dict[str, Any]]:
        return await messages.list_messages(
            self.token_manager, label_id, query, max_results
        )

    async def get_message_raw(self, message_id: str) -> dict[str, Any]:
        return await messages.get_message_raw(self.token_manager, message_id)

    async def get_attachment(
        self, message_id: str, attachment_id: str
    ) -> bytes:
        return await messages.get_attachment(
            self.token_manager, message_id, attachment_id
        )

    async def current_history_id(self) -> str:
        return await history.current_history_id(self.token_manager)

    async def list_history(
        self, start: str
    ) -> tuple[list[dict[str, Any]], str]:
        return await history.list_history(self.token_manager, start)
