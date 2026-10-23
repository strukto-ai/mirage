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

from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any, Protocol

from mirage.core.google import drive
from mirage.core.google.client import TokenManager
from mirage.core.google.drive import ITEM_FIELDS
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow


class DriveApi(Protocol):
    """Every Drive request the Google backends make, as one object.

    A core op reaches Drive only through its accessor's ``drive``, so the
    backend runs against an in-memory Drive wherever another
    implementation is served there.
    """

    async def list_files(
        self,
        folder_id: str,
        drive_id: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]: ...

    async def list_children(
        self, folder_ids: list[str], drive_id: str | None
    ) -> list[dict[str, Any]]: ...

    async def list_shared_drives(self) -> list[dict[str, Any]]: ...

    async def list_all_files(
        self,
        mime_type: str | None = None,
        modified_after: str | None = None,
        modified_before: str | None = None,
    ) -> tuple[list[dict[str, Any]], bool]: ...

    async def search_files(
        self, text: str, parent_ids: list[str], mime_type: str | None = None
    ) -> tuple[list[str], bool]: ...

    async def get_file(
        self, file_id: str, fields: str = ITEM_FIELDS
    ) -> dict[str, Any]: ...

    async def storage_quota(self) -> dict[str, Any]: ...

    async def delete_file(self, file_id: str) -> None: ...

    async def download_file(
        self, file_id: str, window: ByteWindow | None = None
    ) -> bytes: ...

    def download_file_stream(
        self, file_id: str
    ) -> AsyncGenerator[bytes, None]: ...

    async def create_folder(
        self, name: str, parent_id: str
    ) -> dict[str, Any]: ...

    async def upload_file(
        self, name: str, parent_id: str, data: bytes | ByteSpool
    ) -> dict[str, Any]: ...

    async def update_file_content(
        self, file_id: str, data: bytes | ByteSpool
    ) -> dict[str, Any]: ...

    async def patch_file(
        self,
        file_id: str,
        body: dict[str, Any],
        add_parents: str | None = None,
        remove_parents: str | None = None,
    ) -> dict[str, Any]: ...

    async def copy_file(
        self, file_id: str, name: str, parent_id: str
    ) -> dict[str, Any]: ...

    async def start_page_token(self) -> str: ...

    async def list_changes(
        self, page_token: str
    ) -> tuple[list[dict[str, Any]], str]: ...

    async def capture_file_metadata(
        self, file_id: str
    ) -> tuple[str | None, str | None]: ...

    async def download_revision(
        self,
        file_id: str,
        revision_id: str,
        window: ByteWindow | None = None,
    ) -> bytes: ...

    def download_revision_stream(
        self, file_id: str, revision_id: str
    ) -> AsyncGenerator[bytes, None]: ...


@dataclass(frozen=True, slots=True)
class DriveClient:
    """The live ``DriveApi``: one token manager, one wire call per
    method."""

    token_manager: TokenManager

    async def list_files(
        self,
        folder_id: str,
        drive_id: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return await drive.list_files(
            self.token_manager, folder_id, drive_id=drive_id, limit=limit
        )

    async def list_children(
        self, folder_ids: list[str], drive_id: str | None
    ) -> list[dict[str, Any]]:
        return await drive.list_children(
            self.token_manager, folder_ids, drive_id
        )

    async def list_shared_drives(self) -> list[dict[str, Any]]:
        return await drive.list_shared_drives(self.token_manager)

    async def list_all_files(
        self,
        mime_type: str | None = None,
        modified_after: str | None = None,
        modified_before: str | None = None,
    ) -> tuple[list[dict[str, Any]], bool]:
        return await drive.list_all_files(
            self.token_manager,
            mime_type=mime_type,
            modified_after=modified_after,
            modified_before=modified_before,
        )

    async def search_files(
        self, text: str, parent_ids: list[str], mime_type: str | None = None
    ) -> tuple[list[str], bool]:
        return await drive.search_files(
            self.token_manager, text, parent_ids, mime_type
        )

    async def get_file(
        self, file_id: str, fields: str = ITEM_FIELDS
    ) -> dict[str, Any]:
        return await drive.get_file(self.token_manager, file_id, fields)

    async def storage_quota(self) -> dict[str, Any]:
        return await drive.storage_quota(self.token_manager)

    async def delete_file(self, file_id: str) -> None:
        await drive.delete_file(self.token_manager, file_id)

    async def download_file(
        self, file_id: str, window: ByteWindow | None = None
    ) -> bytes:
        return await drive.download_file(self.token_manager, file_id, window)

    def download_file_stream(
        self, file_id: str
    ) -> AsyncGenerator[bytes, None]:
        return drive.download_file_stream(self.token_manager, file_id)

    async def create_folder(self, name: str, parent_id: str) -> dict[str, Any]:
        return await drive.create_folder(self.token_manager, name, parent_id)

    async def upload_file(
        self, name: str, parent_id: str, data: bytes | ByteSpool
    ) -> dict[str, Any]:
        return await drive.upload_file(
            self.token_manager, name, parent_id, data
        )

    async def update_file_content(
        self, file_id: str, data: bytes | ByteSpool
    ) -> dict[str, Any]:
        return await drive.update_file_content(
            self.token_manager, file_id, data
        )

    async def patch_file(
        self,
        file_id: str,
        body: dict[str, Any],
        add_parents: str | None = None,
        remove_parents: str | None = None,
    ) -> dict[str, Any]:
        return await drive.patch_file(
            self.token_manager,
            file_id,
            body,
            add_parents=add_parents,
            remove_parents=remove_parents,
        )

    async def copy_file(
        self, file_id: str, name: str, parent_id: str
    ) -> dict[str, Any]:
        return await drive.copy_file(
            self.token_manager, file_id, name, parent_id
        )

    async def start_page_token(self) -> str:
        return await drive.start_page_token(self.token_manager)

    async def list_changes(
        self, page_token: str
    ) -> tuple[list[dict[str, Any]], str]:
        return await drive.list_changes(self.token_manager, page_token)

    async def capture_file_metadata(
        self, file_id: str
    ) -> tuple[str | None, str | None]:
        """A file's md5 and head revision at read time, each None when
        absent: raw rather than coalesced, because the caller checks the
        md5 against the bytes it downloads.

        Args:
            file_id (str): file ID.
        """
        item = await self.get_file(file_id, "headRevisionId,md5Checksum")
        return item.get("md5Checksum"), item.get("headRevisionId")

    async def download_revision(
        self,
        file_id: str,
        revision_id: str,
        window: ByteWindow | None = None,
    ) -> bytes:
        return await drive.download_revision(
            self.token_manager, file_id, revision_id, window
        )

    def download_revision_stream(
        self, file_id: str, revision_id: str
    ) -> AsyncGenerator[bytes, None]:
        return drive.download_revision_stream(
            self.token_manager, file_id, revision_id
        )
