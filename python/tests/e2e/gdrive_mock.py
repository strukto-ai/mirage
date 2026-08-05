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
from unittest.mock import patch

_FAKE_TOKEN = "fake-gdrive-token"
_FAKE_EXPIRES_IN = 9999999999

_FOLDER_MIME = "application/vnd.google-apps.folder"
_FILE_MIME = "application/octet-stream"

_PATCH_TARGETS = {
    # Every module that imports the function by value needs its own
    # binding: patching one leaves the others pointing at the real Drive
    # API, which 401s mid-test. `find` reaches Drive through resolve and
    # tree, neither of which readdir's binding covers (#684).
    "list_files": [
        "mirage.core.gdrive.readdir.list_files",
        "mirage.core.gdrive.resolve.list_files",
        "mirage.core.gdrive.tree.list_files",
        "mirage.core.gdrive.rename.list_files",
    ],
    "list_shared_drives": [
        "mirage.core.gdrive.readdir.list_shared_drives",
        "mirage.core.gdrive.resolve.list_shared_drives",
    ],
    "list_all_files": [
        "mirage.core.gdocs.readdir.list_all_files",
        "mirage.core.gsheets.readdir.list_all_files",
        "mirage.core.gslides.readdir.list_all_files",
    ],
    "download_file": [
        "mirage.core.gdrive.read.download_file",
    ],
    "capture_file_metadata": [
        "mirage.core.gdrive.read.capture_file_metadata",
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


def _sliced(data: bytes, range_header: str | None) -> bytes:
    """Apply an HTTP ``Range`` value the way Drive would.

    Args:
        data (bytes): the whole object.
        range_header (str | None): a ``bytes=<start>-<end>`` value, or
            None for the whole thing.
    """
    if not range_header:
        return data
    span = range_header.split("=", 1)[1]
    start_text, _, end_text = span.partition("-")
    start = int(start_text)
    return data[start:int(end_text) + 1] if end_text else data[start:]


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
        modified_after: str | None = None,
        modified_before: str | None = None,
        name: str | None = None,
    ) -> list[dict]:
        # The signature mirrors the real list_files so a caller that passes
        # a filter this fake ignores fails loudly at the call site rather
        # than silently listing an unfiltered folder. `name` is honored
        # because resolve_key walks a path one exact name at a time.
        del drive_id, mime_type, trashed, page_size
        del modified_after, modified_before
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            return []
        children = fake.list_children(folder_id)
        if name is not None:
            children = [c for c in children if c.get("name") == name]
        return children

    async def fake_list_all_files(
        token_manager,
        mime_type: str | None = None,
        trashed: bool = False,
        page_size: int = 1000,
    ) -> tuple[list[dict], bool]:
        del mime_type, trashed, page_size
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            return [], True
        return fake.all_files(), True

    async def fake_list_shared_drives(token_manager) -> list[dict]:
        return []

    async def fake_download_file(token_manager,
                                 file_id: str,
                                 range_header: str | None = None) -> bytes:
        # The Range is served here rather than ignored: Drive honours it
        # for a binary file, so a fake that returned the whole object
        # would hide a ranged read asking for the wrong window.
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            raise FileNotFoundError(file_id)
        data = None
        if fake.has_id(file_id):
            data = fake.get_bytes(file_id)
        else:
            for _, other in registry:
                if other.has_id(file_id):
                    data = other.get_bytes(file_id)
                    break
        if data is None:
            raise FileNotFoundError(file_id)
        return _sliced(data, range_header)

    async def fake_capture_file_metadata(
            token_manager, file_id: str) -> tuple[str | None, str | None]:
        data = await fake_download_file(token_manager, file_id)
        digest = hashlib.md5(data).hexdigest()
        return digest, f"rev-{digest}"

    return {
        "refresh": fake_refresh,
        "list_files": fake_list_files,
        "list_shared_drives": fake_list_shared_drives,
        "list_all_files": fake_list_all_files,
        "download_file": fake_download_file,
        "capture_file_metadata": fake_capture_file_metadata,
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
            # A target that will not resolve used to be skipped, which is
            # how #684 stayed quiet: the binding kept pointing at the real
            # Drive API and the test reached the network. A stale target is
            # a fixture bug, so it fails here.
            try:
                stack.enter_context(patch(target, new=fakes[name]))
            except (AttributeError, ModuleNotFoundError) as exc:
                stack.close()
                raise AssertionError(
                    f"gdrive_mock cannot patch {target!r}: {exc}. Fix the "
                    "target in _PATCH_TARGETS; leaving it unpatched sends "
                    "the test to the real Drive API.") from exc
    return stack
