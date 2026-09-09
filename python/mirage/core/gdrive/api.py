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

from mirage.core.gdrive.versions import (capture_file_metadata,
                                         download_revision, list_revisions)
from mirage.core.google.client import TokenManager
from mirage.core.google.drive import (DEFAULT_UPLOAD_MIME, copy_file,
                                      create_folder, delete_file,
                                      download_file, get_file, list_files,
                                      list_shared_drives, patch_file,
                                      update_file_content, upload_file)
from mirage.utils.ranges import ByteWindow


class DriveApi(Protocol):
    """Every Drive request the gdrive backend makes, as one object.

    A core op reaches the network only through ``accessor.drive``, so the
    whole backend can be stood up against an in-memory Drive by supplying
    a different implementation of this protocol. Importing a wire function
    from ``core.google.drive`` or ``core.gdrive.versions`` into a core
    module puts a second, unswappable door beside this one, which is what
    #684 was: the fake covered readdir's binding and ``find`` reached the
    live API through resolve's.
    """

    async def list_files(
        self,
        folder_id: str = "root",
        drive_id: str | None = None,
        mime_type: str | None = None,
        trashed: bool = False,
        page_size: int = 1000,
        modified_after: str | None = None,
        modified_before: str | None = None,
        name: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        ...

    async def list_shared_drives(self,
                                 page_size: int = 100) -> list[dict[str, Any]]:
        ...

    async def get_file(self, file_id: str) -> dict[str, Any]:
        ...

    async def delete_file(self, file_id: str) -> None:
        ...

    async def download_file(self,
                            file_id: str,
                            window: ByteWindow | None = None) -> bytes:
        ...

    async def create_folder(self, name: str, parent_id: str) -> dict[str, Any]:
        ...

    async def upload_file(
        self,
        name: str,
        parent_id: str,
        data: bytes,
        mime_type: str = DEFAULT_UPLOAD_MIME,
    ) -> dict[str, Any]:
        ...

    async def update_file_content(
        self,
        file_id: str,
        data: bytes,
        mime_type: str = DEFAULT_UPLOAD_MIME,
    ) -> dict[str, Any]:
        ...

    async def patch_file(
        self,
        file_id: str,
        body: dict[str, Any] | None = None,
        add_parents: str | None = None,
        remove_parents: str | None = None,
    ) -> dict[str, Any]:
        ...

    async def copy_file(self, file_id: str, name: str,
                        parent_id: str) -> dict[str, Any]:
        ...

    async def list_revisions(self, file_id: str) -> list[dict[str, Any]]:
        ...

    async def download_revision(
        self,
        file_id: str,
        revision_id: str,
        window: ByteWindow | None = None,
    ) -> bytes:
        ...

    async def capture_file_metadata(
            self, file_id: str) -> tuple[str | None, str | None]:
        ...


@dataclass(frozen=True, slots=True)
class DriveClient:
    """The live ``DriveApi``: one token manager, one call per method."""

    token_manager: TokenManager

    async def list_files(
        self,
        folder_id: str = "root",
        drive_id: str | None = None,
        mime_type: str | None = None,
        trashed: bool = False,
        page_size: int = 1000,
        modified_after: str | None = None,
        modified_before: str | None = None,
        name: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return await list_files(self.token_manager,
                                folder_id=folder_id,
                                drive_id=drive_id,
                                mime_type=mime_type,
                                trashed=trashed,
                                page_size=page_size,
                                modified_after=modified_after,
                                modified_before=modified_before,
                                name=name,
                                limit=limit)

    async def list_shared_drives(self,
                                 page_size: int = 100) -> list[dict[str, Any]]:
        return await list_shared_drives(self.token_manager,
                                        page_size=page_size)

    async def get_file(self, file_id: str) -> dict[str, Any]:
        return await get_file(self.token_manager, file_id)

    async def delete_file(self, file_id: str) -> None:
        await delete_file(self.token_manager, file_id)

    async def download_file(self,
                            file_id: str,
                            window: ByteWindow | None = None) -> bytes:
        return await download_file(self.token_manager, file_id, window)

    async def create_folder(self, name: str, parent_id: str) -> dict[str, Any]:
        return await create_folder(self.token_manager, name, parent_id)

    async def upload_file(
        self,
        name: str,
        parent_id: str,
        data: bytes,
        mime_type: str = DEFAULT_UPLOAD_MIME,
    ) -> dict[str, Any]:
        return await upload_file(self.token_manager,
                                 name,
                                 parent_id,
                                 data,
                                 mime_type=mime_type)

    async def update_file_content(
        self,
        file_id: str,
        data: bytes,
        mime_type: str = DEFAULT_UPLOAD_MIME,
    ) -> dict[str, Any]:
        return await update_file_content(self.token_manager,
                                         file_id,
                                         data,
                                         mime_type=mime_type)

    async def patch_file(
        self,
        file_id: str,
        body: dict[str, Any] | None = None,
        add_parents: str | None = None,
        remove_parents: str | None = None,
    ) -> dict[str, Any]:
        return await patch_file(self.token_manager,
                                file_id,
                                body,
                                add_parents=add_parents,
                                remove_parents=remove_parents)

    async def copy_file(self, file_id: str, name: str,
                        parent_id: str) -> dict[str, Any]:
        return await copy_file(self.token_manager, file_id, name, parent_id)

    async def list_revisions(self, file_id: str) -> list[dict[str, Any]]:
        return await list_revisions(self.token_manager, file_id)

    async def download_revision(
        self,
        file_id: str,
        revision_id: str,
        window: ByteWindow | None = None,
    ) -> bytes:
        return await download_revision(self.token_manager, file_id,
                                       revision_id, window)

    async def capture_file_metadata(
            self, file_id: str) -> tuple[str | None, str | None]:
        return await capture_file_metadata(self.token_manager, file_id)


def drive_api(token_manager: TokenManager) -> DriveApi:
    """Build the live Drive door for a token manager.

    This is the one factory a test replaces to swap the whole backend for
    an in-memory Drive, the way ``async_session`` is for S3.

    Args:
        token_manager (TokenManager): OAuth2 token manager.

    Returns:
        DriveApi: the live implementation.
    """
    return DriveClient(token_manager)
