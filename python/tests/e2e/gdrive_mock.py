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
from collections.abc import AsyncGenerator
from contextlib import ExitStack
from typing import Any
from unittest.mock import patch

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.drive import ITEM_FIELDS
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow
from tests.fixtures.gdrive_api import payload

_FAKE_TOKEN = "fake-gdrive-token"
_FAKE_EXPIRES_IN = 9999999999

# A stream answers in pieces of this size, so a reader that stops after the
# first one leaves the rest unpulled.
_STREAM_CHUNK = 8192

_FOLDER_MIME = "application/vnd.google-apps.folder"
_FILE_MIME = "application/octet-stream"
_NATIVE_MIMES = frozenset(
    {
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
    }
)


def _is_native(mime: str) -> bool:
    """Whether Drive renders this type rather than storing bytes for it.

    Args:
        mime (str): the item's MIME type.
    """
    return mime in _NATIVE_MIMES


class FakeGDrive:
    def __init__(self) -> None:
        self._next_id: int = 1
        self._children: dict[str, list[dict]] = {"root": []}
        self._bytes: dict[str, bytes] = {}
        # One entry per Drive call the fake answered, so a test can pin
        # what a warm read costs rather than inferring it from output.
        # Mirrors `tests/e2e/s3_mock.py`'s `MultiBucketS3Client.calls`.
        self.calls: Counter[str] = Counter()

    def add_file(
        self, path: str, content: bytes, mime: str = _FILE_MIME
    ) -> str:
        parts = [p for p in path.strip("/").split("/") if p]
        if not parts:
            raise ValueError(f"invalid file path: {path}")
        parent_id = self._ensure_dirs(parts[:-1])
        name = parts[-1]
        existing = self._find_child(parent_id, name)
        if existing is not None:
            return self._overwrite(existing, content)["id"]
        entry = self._new_file(
            parent_id, name, content, mime, "2026-04-16T00:00:00Z"
        )
        return entry["id"]

    def upload(self, parent_id: str, name: str, content: bytes) -> dict:
        """Create a file under a folder id, as a multipart upload does.

        Args:
            parent_id (str): the parent folder's id.
            name (str): the new file's name.
            content (bytes): its bytes.
        """
        entry = self._new_file(
            parent_id, name, content, _FILE_MIME, self._next_modified_time()
        )
        return self.public(entry)

    def mkdir(self, parent_id: str, name: str) -> dict:
        """Create a folder under a folder id, as Drive's files.create does.

        Args:
            parent_id (str): the parent folder's id.
            name (str): the new folder's name.
        """
        folder_id = self._mk_id("d")
        entry = {
            "id": folder_id,
            "name": name,
            "mimeType": _FOLDER_MIME,
            "modifiedTime": self._next_modified_time(),
            "parents": [parent_id],
        }
        self._children.setdefault(parent_id, []).append(entry)
        self._children[folder_id] = []
        return self.public(entry)

    def update(self, file_id: str, content: bytes) -> dict:
        """Replace a file's bytes by id, as a media upload does.

        Args:
            file_id (str): the file's id.
            content (bytes): its new bytes.
        """
        entry = self._entry(file_id)
        if entry is None:
            raise FileNotFoundError(file_id)
        return self.public(self._overwrite(entry, content))

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
        entry = (
            None
            if parent_id is None
            else self._find_child(parent_id, parts[-1])
        )
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
            entry["mimeType"]
        ):
            data = self._bytes.get(entry["id"], b"")
            out["md5Checksum"] = hashlib.md5(data).hexdigest()
            out["headRevisionId"] = f"{entry['id']}-r1"
        return out

    def list_children(self, folder_id: str) -> list[dict]:
        return [self.public(c) for c in self._children.get(folder_id, [])]

    def find_entry(self, file_id: str) -> dict | None:
        entry = self._entry(file_id)
        return self.public(entry) if entry is not None else None

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

    def _entry(self, file_id: str) -> dict | None:
        for children in self._children.values():
            for c in children:
                if c["id"] == file_id:
                    return c
        return None

    def _new_file(
        self,
        parent_id: str,
        name: str,
        content: bytes,
        mime: str,
        modified: str,
    ) -> dict:
        file_id = self._mk_id("f")
        entry = {
            "id": file_id,
            "name": name,
            "mimeType": mime,
            "size": str(len(content)),
            "modifiedTime": modified,
            "parents": [parent_id],
        }
        self._children.setdefault(parent_id, []).append(entry)
        self._bytes[file_id] = content
        return entry

    def _overwrite(self, entry: dict, content: bytes) -> dict:
        self._bytes[entry["id"]] = content
        entry["size"] = str(len(content))
        entry["modifiedTime"] = self._next_modified_time()
        return entry

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


def _sliced(data: bytes, window: ByteWindow | None) -> bytes:
    """Serve a byte window the way Drive serves a ``Range``.

    Args:
        data (bytes): the whole object.
        window (ByteWindow | None): the window, or None for all of it.
    """
    if window is None:
        return data
    end = None if window.size is None else window.offset + window.size
    return data[window.offset : end]


class FakeDriveApi:
    """The ``DriveApi`` one ``FakeGDrive`` answers, counting each call on
    the fake. A call it does not answer fails the test."""

    def __init__(
        self, fake: FakeGDrive, registry: list[tuple[Any, FakeGDrive]]
    ) -> None:
        """Args:
        fake (FakeGDrive): the tree this mount's token resolved to.
        registry (list[tuple[Any, FakeGDrive]]): every (token_manager,
            FakeGDrive) pair, for a cross-mount read of another's file.
        """
        self._fake = fake
        self._registry = registry

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        raise AssertionError(f"gdrive_mock does not answer Drive.{name}")

    async def list_files(
        self,
        folder_id: str,
        drive_id: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        del drive_id
        self._fake.calls["list_files"] += 1
        children = self._fake.list_children(folder_id)
        return children if limit is None else children[:limit]

    async def list_children(
        self, folder_ids: list[str], drive_id: str | None
    ) -> list[dict]:
        del drive_id
        self._fake.calls["list_children"] += 1
        return [
            child
            for folder_id in folder_ids
            for child in self._fake.list_children(folder_id)
        ]

    async def list_shared_drives(self) -> list[dict]:
        return []

    async def list_all_files(
        self,
        mime_type: str | None = None,
        modified_after: str | None = None,
        modified_before: str | None = None,
    ) -> tuple[list[dict], bool]:
        del modified_after, modified_before
        return [
            f
            for f in self._fake.all_files()
            if mime_type is None or f["mimeType"] == mime_type
        ], True

    async def get_file(self, file_id: str, fields: str = ITEM_FIELDS) -> dict:
        del fields
        self._fake.calls["get_file"] += 1
        entry = self._fake.find_entry(file_id)
        if entry is None:
            raise FileNotFoundError(file_id)
        return entry

    async def download_file(
        self, file_id: str, window: ByteWindow | None = None
    ) -> bytes:
        self._fake.calls["download_file"] += 1
        return _sliced(self.bytes_of(file_id), window)

    async def download_file_stream(
        self, file_id: str
    ) -> AsyncGenerator[bytes, None]:
        self._fake.calls["download_file"] += 1
        data = self.bytes_of(file_id)
        for at in range(0, len(data), _STREAM_CHUNK):
            yield data[at : at + _STREAM_CHUNK]

    async def capture_file_metadata(
        self, file_id: str
    ) -> tuple[str | None, str | None]:
        self._fake.calls["capture_file_metadata"] += 1
        digest = hashlib.md5(self.bytes_of(file_id)).hexdigest()
        return digest, f"rev-{digest}"

    async def upload_file(
        self, name: str, parent_id: str, data: bytes | ByteSpool
    ) -> dict:
        self._fake.calls["upload_file"] += 1
        return self._fake.upload(parent_id, name, await payload(data))

    async def update_file_content(
        self, file_id: str, data: bytes | ByteSpool
    ) -> dict:
        self._fake.calls["update_file_content"] += 1
        return self._fake.update(file_id, await payload(data))

    async def create_folder(self, name: str, parent_id: str) -> dict:
        self._fake.calls["create_folder"] += 1
        return self._fake.mkdir(parent_id, name)

    def render(self, file_id: str) -> bytes:
        """A native file's rendering: its stored bytes, counted as the
        cost a warm native read avoids.

        Args:
            file_id (str): the Drive file id.
        """
        self._fake.calls["render"] += 1
        return self.bytes_of(file_id)

    def bytes_of(self, file_id: str) -> bytes:
        """The stored bytes for ``file_id``, from any registered fake, as
        a cross-mount read reaches a file another fake owns.

        Args:
            file_id (str): the Drive file id.
        """
        for fake in (self._fake, *(other for _, other in self._registry)):
            if fake.has_id(file_id):
                return fake.get_bytes(file_id)
        raise FileNotFoundError(file_id)


class FakeRenderApi:
    """The Docs, Sheets and Slides renderings of one ``FakeGDrive``'s
    native files: their stored bytes, counted on the fake. Any other call
    fails the test."""

    def __init__(self, drive: FakeDriveApi) -> None:
        """Args:
        drive (FakeDriveApi): the Drive whose files are rendered.
        """
        self._drive = drive

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        raise AssertionError(f"gdrive_mock does not render {name}")

    async def read_doc(self, doc_id: str) -> bytes:
        return self._drive.render(doc_id)

    async def read_spreadsheet(self, spreadsheet_id: str) -> bytes:
        return self._drive.render(spreadsheet_id)

    async def read_presentation(self, presentation_id: str) -> bytes:
        return self._drive.render(presentation_id)


def _resolve_fake(token_manager, registry) -> FakeGDrive:
    for tm, fake in registry:
        if tm is None or tm is token_manager:
            return fake
    raise AssertionError("no FakeGDrive was registered for this mount")


def patch_gdrive(*pairs) -> ExitStack:
    """Serve gdrive from in-memory fakes, selected by token manager.

    Every Google accessor serves a ``FakeDriveApi`` as its Drive and a
    ``FakeRenderApi`` as its Docs, Sheets and Slides, so any call a
    Drive-backed mount makes is answered by the fake or fails the test.

    Args:
        *pairs: (token_manager, FakeGDrive) tuples, or one FakeGDrive.
            The right fake is selected by token_manager identity, so
            several gdrive mounts can coexist with separate trees.
    """
    if len(pairs) == 1 and isinstance(pairs[0], FakeGDrive):
        registry = [(None, pairs[0])]
    else:
        registry = list(pairs)
    if not registry:
        raise AssertionError("patch_gdrive was given no FakeGDrive")

    def drive_for(token_manager) -> FakeDriveApi:
        return FakeDriveApi(_resolve_fake(token_manager, registry), registry)

    async def fake_refresh(_config):
        return _FAKE_TOKEN, _FAKE_EXPIRES_IN

    rendered = property(
        lambda accessor: FakeRenderApi(drive_for(accessor.token_manager))
    )
    with ExitStack() as stack:
        stack.enter_context(
            patch.object(
                GoogleApiAccessor,
                "drive",
                property(lambda accessor: drive_for(accessor.token_manager)),
            )
        )
        for service in ("docs", "sheets", "slides"):
            stack.enter_context(
                patch.object(GoogleApiAccessor, service, rendered)
            )
        stack.enter_context(
            patch(
                "mirage.core.google.client.refresh_access_token",
                new=fake_refresh,
            )
        )
        return stack.pop_all()
