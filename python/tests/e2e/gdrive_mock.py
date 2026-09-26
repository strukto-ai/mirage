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
from collections import Counter
from contextlib import ExitStack
from unittest.mock import patch

_FAKE_TOKEN = "fake-gdrive-token"
_FAKE_EXPIRES_IN = 9999999999

_FOLDER_MIME = "application/vnd.google-apps.folder"
_FILE_MIME = "application/octet-stream"
_NATIVE_MIMES = frozenset({
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
})


def _is_native(mime: str) -> bool:
    """Whether Drive renders this type rather than storing bytes for it.

    Args:
        mime (str): the item's MIME type.
    """
    return mime in _NATIVE_MIMES


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
    # `stat_from_api` answers a stat made with no index, which is how the
    # read-token contract's unrecorded rows stat. The guard below catches
    # only a target that no longer resolves, so an unlisted binding would
    # keep pointing at the real Drive API (#684's shape).
    "get_file": [
        "mirage.core.gdrive.stat.get_file",
        "mirage.core.gdrive.resolve.get_file",
    ],
    # A native file's bytes do not exist until Docs, Sheets or Slides
    # renders them, so the fake stands in for the renderer and counts each
    # render as the cost a warm native read avoids.
    "render": [
        "mirage.core.gdrive.read.read_doc",
        "mirage.core.gdrive.read.read_spreadsheet",
        "mirage.core.gdrive.read.read_presentation",
    ],
}


class FakeGDrive:

    def __init__(self) -> None:
        self._next_id: int = 1
        self._children: dict[str, list[dict]] = {"root": []}
        self._bytes: dict[str, bytes] = {}
        # One entry per Drive call the fake answered, so a test can pin
        # what a warm read costs rather than inferring it from output.
        # Mirrors `tests/e2e/s3_mock.py`'s `MultiBucketS3Client.calls`.
        self.calls: Counter[str] = Counter()

    def add_file(self,
                 path: str,
                 content: bytes,
                 mime: str = _FILE_MIME) -> str:
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
            "mimeType": mime,
            "size": str(len(content)),
            "modifiedTime": "2026-04-16T00:00:00Z",
            "parents": [parent_id],
        }
        self._children[parent_id].append(entry)
        self._bytes[file_id] = content
        return file_id

    def set_modified(self, path: str, stamp: str) -> None:
        """Set an item's modifiedTime, as an edit made outside mirage does.

        A native file's only token is its modifiedTime, and
        ``_next_modified_time`` repeats across overwrites, so a test that
        needs the stamp to move sets it here.

        Args:
            path (str): the item's path under the fake's root.
            stamp (str): the new modifiedTime.
        """
        parts = [p for p in path.strip("/").split("/") if p]
        parent_id = self._lookup_dirs(parts[:-1])
        entry = (None if parent_id is None else self._find_child(
            parent_id, parts[-1]))
        if entry is None:
            raise FileNotFoundError(path)
        entry["modifiedTime"] = stamp

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

    def public(self, entry: dict) -> dict:
        """Serve an entry the way Drive serves a file resource.

        The two content tokens are computed here rather than stored,
        because ``add_file`` overwrites bytes in place and a stored md5
        would then describe the previous content.

        Drive's own guards apply (integ/server/gws/drive/item.ts):
        neither a folder nor a native google-apps file carries either
        field. Handing a gdoc an md5 Drive never returns is the fidelity
        trap the unit fakes' guards exist to avoid.

        Args:
            entry (dict): the stored child record.
        """
        out = dict(entry)
        if entry["mimeType"] != _FOLDER_MIME and not _is_native(
                entry["mimeType"]):
            data = self._bytes.get(entry["id"], b"")
            out["md5Checksum"] = hashlib.md5(data).hexdigest()
            out["headRevisionId"] = f"{entry['id']}-r1"
        return out

    def list_children(self, folder_id: str) -> list[dict]:
        return [self.public(c) for c in self._children.get(folder_id, [])]

    def find_entry(self, file_id: str) -> dict | None:
        for children in self._children.values():
            for c in children:
                if c["id"] == file_id:
                    return self.public(c)
        return None

    def all_files(self) -> list[dict]:
        result: list[dict] = []
        for children in self._children.values():
            for c in children:
                if c["mimeType"] != _FOLDER_MIME:
                    result.append(self.public(c))
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


def _bytes_for(fake, registry, file_id: str) -> bytes:
    """The stored bytes for ``file_id``, from any registered fake.

    A cross-mount read reaches a file another fake owns, so the lookup
    falls through the registry before giving up.

    Args:
        fake (FakeGDrive): the fake the caller's token resolved to.
        registry (list): every (token_manager, FakeGDrive) pair.
        file_id (str): the Drive file id.
    """
    if fake.has_id(file_id):
        return fake.get_bytes(file_id)
    for _, other in registry:
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
        fake.calls["list_files"] += 1
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
        fake.calls["download_file"] += 1
        return _sliced(_bytes_for(fake, registry, file_id), range_header)

    async def fake_get_file(token_manager, file_id: str) -> dict:
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            raise FileNotFoundError(file_id)
        fake.calls["get_file"] += 1
        entry = fake.find_entry(file_id)
        if entry is None:
            raise FileNotFoundError(file_id)
        return entry

    async def fake_capture_file_metadata(
            token_manager,
            file_id: str) -> tuple[str | None, str | None, str | None]:
        # Reads the bytes directly rather than through `fake_download_file`,
        # so the download counter stays honest: the real call is a metadata
        # GET and must not read as a download.
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            raise FileNotFoundError(file_id)
        fake.calls["capture_file_metadata"] += 1
        digest = hashlib.md5(_bytes_for(fake, registry, file_id)).hexdigest()
        entry = fake.find_entry(file_id)
        modified = None if entry is None else entry.get("modifiedTime")
        return digest, f"rev-{digest}", modified

    async def fake_render(token_manager, file_id: str) -> bytes:
        fake = _resolve_fake(token_manager, registry)
        if fake is None:
            raise FileNotFoundError(file_id)
        fake.calls["render"] += 1
        return _bytes_for(fake, registry, file_id)

    return {
        "refresh": fake_refresh,
        "render": fake_render,
        "list_files": fake_list_files,
        "list_shared_drives": fake_list_shared_drives,
        "list_all_files": fake_list_all_files,
        "download_file": fake_download_file,
        "capture_file_metadata": fake_capture_file_metadata,
        "get_file": fake_get_file,
    }


def patch_gdrive(*pairs) -> ExitStack:
    """Patch gdrive HTTP layer with (token_manager, FakeGDrive) pairs.

    Args:
        *pairs: tuples of (token_manager, FakeGDrive). The right fake is
            selected by token_manager identity, so multiple gdrive mounts
            can coexist with separate file trees.
    """
    if len(pairs) == 1 and isinstance(pairs[0], FakeGDrive):
        registry = [(None, pairs[0])]
    else:
        registry = list(pairs)
    fakes = _build_fakes(registry)
    stack = ExitStack()
    stack.enter_context(
        patch("mirage.core.google.client.refresh_access_token",
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
