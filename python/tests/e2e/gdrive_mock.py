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
from contextlib import ExitStack
from typing import Any
from unittest.mock import patch

from mirage.core.google.drive import DEFAULT_UPLOAD_MIME
from mirage.utils.ranges import ByteWindow, slice_window

_FOLDER_MIME = "application/vnd.google-apps.folder"
_FILE_MIME = "application/octet-stream"

# One target, because the gdrive backend has one door to Drive: the
# accessor's `drive` property, built by this factory. Before #684 the
# fake had to name a binding inside every core module that imported an
# API function by value, and `find` reached the live API through the two
# nobody had listed.
_SEAM_TARGET = "mirage.accessor.gdrive.drive_api"


class FakeGDrive:

    def __init__(self) -> None:
        self._next_id: int = 1
        self._children: dict[str, list[dict]] = {"root": []}
        self._bytes: dict[str, bytes] = {}

    def add_file(self, path: str, content: bytes) -> str:
        parts = [p for p in path.strip("/").split("/") if p]
        if not parts:
            raise ValueError(f"invalid file path: {path}")
        parent_id = self._ensure_dirs(parts[:-1])
        return self.put_file(parent_id, parts[-1], content)

    def put_file(self,
                 parent_id: str,
                 name: str,
                 content: bytes,
                 mime_type: str = _FILE_MIME) -> str:
        existing = self._find_child(parent_id, name)
        if existing is not None:
            self._bytes[existing["id"]] = content
            existing["size"] = str(len(content))
            existing["modifiedTime"] = self._next_modified_time()
            return str(existing["id"])
        file_id = self._mk_id("f")
        entry = {
            "id": file_id,
            "name": name,
            "mimeType": mime_type,
            "size": str(len(content)),
            "modifiedTime": "2026-04-16T00:00:00Z",
            "parents": [parent_id],
        }
        self._children.setdefault(parent_id, []).append(entry)
        self._bytes[file_id] = content
        return file_id

    def make_folder(self, parent_id: str, name: str) -> dict:
        existing = self._find_child(parent_id, name)
        if existing is not None and existing["mimeType"] == _FOLDER_MIME:
            return existing
        new_id = self._mk_id("d")
        entry = {
            "id": new_id,
            "name": name,
            "mimeType": _FOLDER_MIME,
            "modifiedTime": "2026-04-16T00:00:00Z",
            "parents": [parent_id],
        }
        self._children.setdefault(parent_id, []).append(entry)
        self._children[new_id] = []
        return entry

    def remove_file(self, path: str) -> None:
        parts = [p for p in path.strip("/").split("/") if p]
        if not parts:
            return
        parent_id = self._lookup_dirs(parts[:-1])
        if parent_id is None:
            return
        name = parts[-1]
        children = self._children.get(parent_id, [])
        for i, c in enumerate(list(children)):
            if c["name"] == name:
                self._bytes.pop(c["id"], None)
                children.pop(i)
                return

    def delete_id(self, file_id: str) -> None:
        """Drop an item and, for a folder, everything under it."""
        stack = [file_id]
        while stack:
            current = stack.pop()
            for child in self._children.pop(current, []):
                stack.append(str(child["id"]))
            self._bytes.pop(current, None)
        for children in self._children.values():
            for i, c in enumerate(list(children)):
                if c["id"] == file_id:
                    children.pop(i)
                    return

    def reparent(self, file_id: str, new_parent: str,
                 old_parent: str | None) -> None:
        """Move an item between folders, the way ``files.patch`` does."""
        item = self.item(file_id)
        if item is None:
            raise FileNotFoundError(file_id)
        if old_parent is not None:
            siblings = self._children.get(old_parent, [])
            if item in siblings:
                siblings.remove(item)
        item["parents"] = [new_parent]
        self._children.setdefault(new_parent, []).append(item)

    def list_children(self, folder_id: str) -> list[dict]:
        return list(self._children.get(folder_id, []))

    def all_files(self) -> list[dict]:
        result: list[dict] = []
        for children in self._children.values():
            for c in children:
                if c["mimeType"] != _FOLDER_MIME:
                    result.append(c)
        return result

    def item(self, file_id: str) -> dict | None:
        for children in self._children.values():
            for c in children:
                if c["id"] == file_id:
                    return c
        return None

    def get_bytes(self, file_id: str) -> bytes:
        if file_id not in self._bytes:
            raise FileNotFoundError(file_id)
        return self._bytes[file_id]

    def has_id(self, file_id: str) -> bool:
        return file_id in self._bytes

    def _mk_id(self, kind: str) -> str:
        i = self._next_id
        self._next_id += 1
        return f"{kind}{i:04d}"

    def _next_modified_time(self) -> str:
        # Bump the fake modifiedTime on every overwrite so fingerprint
        # comparisons can detect content mutation in tests.
        i = self._next_id
        return f"2026-04-16T00:00:{i:02d}Z"

    def _ensure_dirs(self, parts: list[str]) -> str:
        parent_id = "root"
        for p in parts:
            parent_id = str(self.make_folder(parent_id, p)["id"])
        return parent_id

    def _lookup_dirs(self, parts: list[str]) -> str | None:
        parent_id = "root"
        for p in parts:
            existing = self._find_child(parent_id, p)
            if existing is None or existing["mimeType"] != _FOLDER_MIME:
                return None
            parent_id = existing["id"]
        return parent_id

    def _find_child(self, parent_id: str, name: str) -> dict | None:
        for c in self._children.get(parent_id, []):
            if c["name"] == name:
                return c
        return None


class FakeDriveApi:
    """A ``DriveApi`` served by one ``FakeGDrive``.

    Implements the whole protocol rather than the handful of calls a
    given suite happens to make: an unimplemented method is what let a
    call reach the network before, and here it would be an
    ``AttributeError`` in the fake instead.

    Args:
        fake (FakeGDrive): the tree this door serves.
        registry (list): every (token_manager, FakeGDrive) pair, so a
            download by id can be answered from a sibling mount's tree.
    """

    def __init__(self, fake: FakeGDrive, registry: list) -> None:
        self.fake = fake
        self.registry = registry

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
        del drive_id, trashed, page_size, modified_after, modified_before
        out = []
        for child in self.fake.list_children(folder_id):
            if name is not None and child.get("name") != name:
                continue
            if mime_type is not None and child.get("mimeType") != mime_type:
                continue
            out.append(child)
            if limit is not None and len(out) >= limit:
                break
        return out

    async def list_shared_drives(self,
                                 page_size: int = 100) -> list[dict[str, Any]]:
        return []

    async def get_file(self, file_id: str) -> dict[str, Any]:
        item = self.fake.item(file_id)
        if item is None:
            raise FileNotFoundError(file_id)
        return item

    async def delete_file(self, file_id: str) -> None:
        self.fake.delete_id(file_id)

    async def download_file(self,
                            file_id: str,
                            window: ByteWindow | None = None) -> bytes:
        data = self._bytes_of(file_id)
        if window is None:
            return data
        return slice_window(data, window.offset, window.size)

    async def create_folder(self, name: str, parent_id: str) -> dict[str, Any]:
        return self.fake.make_folder(parent_id, name)

    async def upload_file(
        self,
        name: str,
        parent_id: str,
        data: bytes,
        mime_type: str = DEFAULT_UPLOAD_MIME,
    ) -> dict[str, Any]:
        file_id = self.fake.put_file(parent_id, name, data, mime_type)
        return await self.get_file(file_id)

    async def update_file_content(
        self,
        file_id: str,
        data: bytes,
        mime_type: str = DEFAULT_UPLOAD_MIME,
    ) -> dict[str, Any]:
        del mime_type
        item = await self.get_file(file_id)
        self.fake.put_file(str(item["parents"][0]), str(item["name"]), data)
        return await self.get_file(file_id)

    async def patch_file(
        self,
        file_id: str,
        body: dict[str, Any] | None = None,
        add_parents: str | None = None,
        remove_parents: str | None = None,
    ) -> dict[str, Any]:
        item = await self.get_file(file_id)
        if body and "name" in body:
            item["name"] = body["name"]
        if add_parents:
            self.fake.reparent(file_id, add_parents, remove_parents)
        return item

    async def copy_file(self, file_id: str, name: str,
                        parent_id: str) -> dict[str, Any]:
        src = await self.get_file(file_id)
        new_id = self.fake.put_file(parent_id, name, self._bytes_of(file_id),
                                    str(src.get("mimeType", _FILE_MIME)))
        return await self.get_file(new_id)

    async def list_revisions(self, file_id: str) -> list[dict[str, Any]]:
        digest = hashlib.md5(self._bytes_of(file_id)).hexdigest()
        return [{"id": f"rev-{digest}"}]

    async def download_revision(
        self,
        file_id: str,
        revision_id: str,
        window: ByteWindow | None = None,
    ) -> bytes:
        del revision_id
        return await self.download_file(file_id, window)

    async def capture_file_metadata(
            self, file_id: str) -> tuple[str | None, str | None]:
        digest = hashlib.md5(self._bytes_of(file_id)).hexdigest()
        return digest, f"rev-{digest}"

    def _bytes_of(self, file_id: str) -> bytes:
        # A cross-mount copy reads a file id this door's own tree does
        # not hold, so the sibling trees answer for it.
        if self.fake.has_id(file_id):
            return self.fake.get_bytes(file_id)
        for _, other in self.registry:
            if other.has_id(file_id):
                return other.get_bytes(file_id)
        raise FileNotFoundError(file_id)


def _resolve_fake(token_manager, registry):
    if not registry:
        return None
    for tm, fake in registry:
        if tm is token_manager:
            return fake
    return registry[0][1]


def patch_gdrive(*pairs) -> ExitStack:
    """Serve every gdrive mount from an in-memory Drive.

    Args:
        *pairs: tuples of (token_manager, FakeGDrive). The right fake is
            selected by token_manager identity, so multiple gdrive resources
            can coexist with separate file trees.
    """
    if len(pairs) == 1 and isinstance(pairs[0], FakeGDrive):
        registry = [(None, pairs[0])]
    else:
        registry = list(pairs)

    def fake_drive_api(token_manager):
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            raise AssertionError("patch_gdrive was given no FakeGDrive")
        return FakeDriveApi(fake, registry)

    stack = ExitStack()
    stack.enter_context(patch(_SEAM_TARGET, new=fake_drive_api))
    return stack
