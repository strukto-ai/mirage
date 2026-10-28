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

import hashlib
import itertools
from collections.abc import Callable
from http import HTTPStatus
from typing import Any

import pytest

from mirage.core.gdrive.api import DriveApi
from mirage.core.google.client import GoogleApiError
from mirage.core.google.drive import FOLDER_MIME, ITEM_FIELDS, MIME_TO_EXT
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow
from tests.fixtures.google_api import StubApi, install_api

FILE_MIME = "application/octet-stream"

DriveCall = Callable[..., Any]


async def payload(data: bytes | ByteSpool) -> bytes:
    """The bytes an upload carries, spooled or not.

    Args:
        data (bytes | ByteSpool): the upload body.
    """
    if isinstance(data, ByteSpool):
        return await data.read(0, data.size)
    return data


def drive_error(status: int, message: str, resource: str) -> GoogleApiError:
    """The error Drive's client raises for a refused request.

    Args:
        status (int): the HTTP status Drive answered.
        message (str): Google's message.
        resource (str): the path below ``drive/v3`` asked for.
    """
    del resource
    return GoogleApiError(message, status)


def not_found(file_id: str) -> GoogleApiError:
    """The error Drive's client raises for an id it holds no file for.

    Args:
        file_id (str): the Drive file id asked for.
    """
    return drive_error(
        HTTPStatus.NOT_FOUND, f"File not found: {file_id}.", f"files/{file_id}"
    )


class FakeDrive:
    """In-memory Drive: id-addressed items with parent links."""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self._ids = itertools.count(1)
        # Every `limit` a caller asked for, so a test can pin that an
        # emptiness probe is bounded. `page_size` cannot express that: it
        # caps the page, not the walk, so a small page turns a listing of
        # a large folder into more requests rather than fewer.
        self.list_limits: list[int | None] = []
        # The parent ids of every full-text search, and whether Drive
        # gave up on a corpus.
        self.searches: list[list[str]] = []
        self.incomplete = False
        # The folder ids and shared drive of every listing of several
        # folders at once, and the limit each was handed.
        self.child_queries: list[tuple[list[str], str | None]] = []
        self.child_limits: list[int | None] = []

    def add(
        self,
        name: str,
        parent: str = "root",
        mime: str = FILE_MIME,
        content: bytes = b"",
        drive_id: str | None = None,
    ) -> str:
        item_id = f"id{next(self._ids)}"
        self.items[item_id] = {
            "id": item_id,
            "name": name,
            "mimeType": mime,
            "parents": [parent],
            "modifiedTime": "2026-01-01T00:00:00Z",
            "content": content,
        }
        if drive_id is not None:
            self.items[item_id]["driveId"] = drive_id
        return item_id

    def folder(self, name: str, parent: str = "root") -> str:
        return self.add(name, parent=parent, mime=FOLDER_MIME)

    def live(self, file_id: str) -> dict:
        """The item ``file_id`` names, as Drive answers a request for it:
        a 404 once it is deleted or was never there.

        Args:
            file_id (str): the Drive file id.
        """
        item = self.items.get(file_id)
        if item is None:
            raise not_found(file_id)
        return item

    def public(self, item_id: str) -> dict:
        item = self.items[item_id]
        out = {k: v for k, v in item.items() if k != "content"}
        out["size"] = str(len(item["content"]))
        mime = item["mimeType"]
        # Drive's own guards, mirrored from integ/server/gws/drive/item.ts:
        # a folder and a native google-apps file carry neither field. Emitting
        # them flatly would give every fake item an md5, so steps 2 and 3 of
        # `drive_fingerprint`'s chain would never execute and the tests that
        # cover them would pass while proving nothing.
        if mime != FOLDER_MIME and mime not in MIME_TO_EXT:
            out["md5Checksum"] = hashlib.md5(item["content"]).hexdigest()
            out["headRevisionId"] = f"{item_id}-r1"
        return out

    async def list_files(
        self,
        folder_id: str,
        drive_id: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        self.list_limits.append(limit)
        out = []
        for item in self.items.values():
            if folder_id not in item["parents"]:
                continue
            out.append(self.public(item["id"]))
            if limit is not None and len(out) >= limit:
                break
        return out

    async def list_children(
        self,
        folder_ids: list[str],
        drive_id: str | None,
        limit: int | None = None,
    ) -> list[dict]:
        self.child_queries.append((list(folder_ids), drive_id))
        self.child_limits.append(limit)
        out = [
            self.public(item["id"])
            for item in self.items.values()
            if set(item["parents"]) & set(folder_ids)
        ]
        return out if limit is None else out[:limit]

    async def list_all_files(
        self,
        mime_type: str | None = None,
        modified_after: str | None = None,
        modified_before: str | None = None,
    ) -> tuple[list[dict], bool]:
        return [
            self.public(item["id"])
            for item in self.items.values()
            if (mime_type is None or item["mimeType"] == mime_type)
            and (
                modified_after is None
                or item["modifiedTime"] >= modified_after
            )
            and (
                modified_before is None
                or item["modifiedTime"] < modified_before
            )
        ], not self.incomplete

    async def search_files(
        self, text: str, parent_ids: list[str], mime_type: str | None = None
    ) -> tuple[list[str], bool]:
        self.searches.append(list(parent_ids))
        ids = [
            item["id"]
            for item in self.items.values()
            if (not parent_ids or set(item["parents"]) & set(parent_ids))
            and (mime_type is None or item["mimeType"] == mime_type)
            and text.lower() in item["content"].decode().lower()
        ]
        return ids, not self.incomplete

    async def list_shared_drives(self) -> list[dict]:
        return []

    async def create_folder(self, name: str, parent_id: str) -> dict:
        return self.public(self.folder(name, parent=parent_id))

    async def upload_file(
        self, name: str, parent_id: str, data: bytes | ByteSpool
    ) -> dict:
        content = await payload(data)
        return self.public(self.add(name, parent=parent_id, content=content))

    async def update_file_content(
        self, file_id: str, data: bytes | ByteSpool
    ) -> dict:
        self.live(file_id)["content"] = await payload(data)
        return self.public(file_id)

    async def delete_file(self, file_id: str) -> None:
        self.live(file_id)
        stack = [file_id]
        while stack:
            current = stack.pop()
            stack.extend(
                i["id"] for i in self.items.values() if current in i["parents"]
            )
            self.items.pop(current, None)

    async def patch_file(
        self,
        file_id: str,
        body: dict,
        add_parents: str | None = None,
        remove_parents: str | None = None,
    ) -> dict:
        item = self.live(file_id)
        item["modifiedTime"] = "2026-10-01T00:00:00Z"
        item.update(body)
        if add_parents:
            item["parents"].append(add_parents)
        if remove_parents:
            item["parents"].remove(remove_parents)
        return self.public(file_id)

    async def copy_file(self, file_id: str, name: str, parent_id: str) -> dict:
        src = self.live(file_id)
        return self.public(
            self.add(
                name,
                parent=parent_id,
                mime=src["mimeType"],
                content=src["content"],
            )
        )

    async def download_file(
        self, file_id: str, window: ByteWindow | None = None
    ) -> bytes:
        data = self.live(file_id)["content"]
        if window is None:
            return data
        end = None if window.size is None else window.offset + window.size
        return data[window.offset : end]

    async def get_file(self, file_id: str, fields: str = ITEM_FIELDS) -> dict:
        self.live(file_id)
        return self.public(file_id)

    def find(self, name: str) -> dict | None:
        for item in self.items.values():
            if item["name"] == name:
                return item
        return None


class StubDrive(StubApi):
    """A ``DriveApi`` that answers only the calls a test armed; any other
    call fails the test."""

    service = "Drive"


def install_drive(
    monkeypatch: pytest.MonkeyPatch, drive: DriveApi | StubDrive | FakeDrive
) -> None:
    """Serve ``drive`` from every Google accessor for the test.

    Args:
        monkeypatch (pytest.MonkeyPatch): the test's monkeypatch.
        drive (DriveApi | StubDrive | FakeDrive): what every gdrive core
            op reaches.
    """
    install_api(monkeypatch, drive=drive)
