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

from contextlib import ExitStack
from unittest.mock import patch

_FAKE_TOKEN = "fake-gdrive-token"
_FAKE_EXPIRES_IN = 9999999999

_FOLDER_MIME = "application/vnd.google-apps.folder"
_FILE_MIME = "application/octet-stream"

_PATCH_TARGETS = {
    "list_files": [
        "mirage.core.gdrive.readdir.list_files",
    ],
    "list_shared_drives": [
        "mirage.core.gdrive.readdir.list_shared_drives",
    ],
    "list_all_files": [
        "mirage.core.gdocs.readdir.list_all_files",
        "mirage.core.gsheets.readdir.list_all_files",
        "mirage.core.gslides.readdir.list_all_files",
    ],
    "download_file": [
        "mirage.core.gdrive.read.download_file",
    ],
}


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
        name = parts[-1]
        existing = self._find_child(parent_id, name)
        if existing is not None:
            self._bytes[existing["id"]] = content
            existing["size"] = str(len(content))
            existing["modifiedTime"] = self._next_modified_time()
            return existing["id"]
        file_id = self._mk_id("f")
        entry = {
            "id": file_id,
            "name": name,
            "mimeType": _FILE_MIME,
            "size": str(len(content)),
            "modifiedTime": "2026-04-16T00:00:00Z",
            "parents": [parent_id],
        }
        self._children[parent_id].append(entry)
        self._bytes[file_id] = content
        return file_id

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

    def list_children(self, folder_id: str) -> list[dict]:
        return list(self._children.get(folder_id, []))

    def all_files(self) -> list[dict]:
        result: list[dict] = []
        for children in self._children.values():
            for c in children:
                if c["mimeType"] != _FOLDER_MIME:
                    result.append(c)
        return result

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
            existing = self._find_child(parent_id, p)
            if existing is not None and existing["mimeType"] == _FOLDER_MIME:
                parent_id = existing["id"]
                continue
            new_id = self._mk_id("d")
            entry = {
                "id": new_id,
                "name": p,
                "mimeType": _FOLDER_MIME,
                "modifiedTime": "2026-04-16T00:00:00Z",
                "parents": [parent_id],
            }
            self._children[parent_id].append(entry)
            self._children[new_id] = []
            parent_id = new_id
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


def _resolve_fake(token_manager, registry):
    if not registry:
        return None
    for tm, fake in registry:
        if tm is token_manager:
            return fake
    return registry[0][1]


def _build_fakes(registry):

    async def fake_refresh(_config):
        return _FAKE_TOKEN, _FAKE_EXPIRES_IN

    async def fake_list_files(
        token_manager,
        folder_id: str = "root",
        drive_id: str | None = None,
        mime_type: str | None = None,
        trashed: bool = False,
        page_size: int = 1000,
    ) -> list[dict]:
        del drive_id, mime_type, trashed, page_size
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            return []
        return fake.list_children(folder_id)

    async def fake_list_all_files(
        token_manager,
        mime_type: str | None = None,
        trashed: bool = False,
        page_size: int = 1000,
    ) -> list[dict]:
        del mime_type, trashed, page_size
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            return []
        return fake.all_files()

    async def fake_list_shared_drives(token_manager) -> list[dict]:
        return []

    async def fake_download_file(token_manager, file_id: str) -> bytes:
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            raise FileNotFoundError(file_id)
        if fake.has_id(file_id):
            return fake.get_bytes(file_id)
        for _, other in registry:
            if other.has_id(file_id):
                return other.get_bytes(file_id)
        raise FileNotFoundError(file_id)

    return {
        "refresh": fake_refresh,
        "list_files": fake_list_files,
        "list_shared_drives": fake_list_shared_drives,
        "list_all_files": fake_list_all_files,
        "download_file": fake_download_file,
    }


def patch_gdrive(*pairs) -> ExitStack:
    """Patch gdrive HTTP layer with (token_manager, FakeGDrive) pairs.

    Args:
        *pairs: tuples of (token_manager, FakeGDrive). The right fake is
            selected by token_manager identity, so multiple gdrive resources
            can coexist with separate file trees.
    """
    if len(pairs) == 1 and isinstance(pairs[0], FakeGDrive):
        registry = [(None, pairs[0])]
    else:
        registry = list(pairs)
    fakes = _build_fakes(registry)
    stack = ExitStack()
    stack.enter_context(
        patch("mirage.core.google._client.refresh_access_token",
              new=fakes["refresh"]))
    for name, targets in _PATCH_TARGETS.items():
        for target in targets:
            try:
                stack.enter_context(patch(target, new=fakes[name]))
            except (AttributeError, ModuleNotFoundError):
                pass
    return stack
