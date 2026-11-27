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
import json
from dataclasses import dataclass, field
from typing import Any

from mirage.core.dropbox.client import DropboxApiError

BLOCK = 4 * 1024 * 1024
MODIFIED = "2026-01-01T00:00:00Z"


def content_hash(data: bytes) -> str:
    """Dropbox's content_hash: SHA-256 over the 4 MiB block digests.

    Args:
        data (bytes): the file's bytes.
    """
    blocks = [data[i : i + BLOCK] for i in range(0, len(data), BLOCK)]
    joined = b"".join(hashlib.sha256(b).digest() for b in blocks)
    return hashlib.sha256(joined).hexdigest()


def _norm(path: str) -> str:
    return "/" + "/".join(p for p in path.split("/") if p)


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


class DropboxFakeError(DropboxApiError):
    """An error raised by FakeDropbox simulating Dropbox API refusals."""

    def __init__(
        self,
        message: str,
        status: int = 409,
        summary: str = "",
        error_tag: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message, status=status, summary=summary)
        self.error_tag = error_tag
        self.headers = headers or {}


@dataclass
class FakeDropbox:
    """Dropbox's file routes over an in-memory store, for the simulator.

    The simulator's loop refuses real I/O, so its seam answers Mirage's
    Dropbox calls from here, in process. Every answer renders a file with
    ``_file_entry``, so an upload reply's content_hash and a later stat's
    cannot disagree, and a download names the file's metadata the way
    ``Dropbox-API-Result`` does.

    Every content write mints a new ``rev``, as Dropbox does even for the
    same bytes. An upload in ``update`` mode whose rev is not the file's
    answers 409 ``path/conflict/file/``, and ``delete_v2`` with a stale
    ``parent_rev`` answers 409 ``path_write/conflict/file/`` (measured
    2026-10-05 and 2026-10-08). A write under a file answers
    ``conflict/file``, Dropbox's "a file in the way", so the file stays a
    file.

    Args:
        files (dict[str, bytes]): Dropbox path to bytes.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    revs: dict[str, str] = field(default_factory=dict)
    dirs: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self._serial = itertools.count(1)
        self.files = {_norm(k): v for k, v in self.files.items()}
        for path in self.files:
            self._mint(path)

    def _mint(self, path: str) -> None:
        self.revs[path] = f"{next(self._serial):09x}"
        parts = path.strip("/").split("/")[:-1]
        for i in range(1, len(parts) + 1):
            self.dirs.add("/" + "/".join(parts[:i]))

    def _file_in_way(self, path: str) -> bool:
        parts = path.strip("/").split("/")[:-1]
        return any(
            "/" + "/".join(parts[:i]) in self.files
            for i in range(1, len(parts) + 1)
        )

    def _folders(self) -> set[str]:
        out = {"/"} | self.dirs
        for key in self.files:
            parts = key.strip("/").split("/")[:-1]
            for i in range(1, len(parts) + 1):
                out.add("/" + "/".join(parts[:i]))
        return out

    def _file_entry(self, path: str) -> dict[str, Any]:
        data = self.files[path]
        return {
            ".tag": "file",
            "name": path.rsplit("/", 1)[-1],
            "path_display": path,
            "path_lower": path.lower(),
            "id": "id:" + path,
            "size": len(data),
            "server_modified": MODIFIED,
            "client_modified": MODIFIED,
            "content_hash": content_hash(data),
            "rev": self.revs[path],
        }

    def _folder_entry(self, path: str) -> dict[str, Any]:
        return {
            ".tag": "folder",
            "name": path.rsplit("/", 1)[-1],
            "path_display": path,
            "path_lower": path.lower(),
            "id": "id:" + path,
        }

    def _children(self, path: str) -> list[dict[str, Any]]:
        base = path.rstrip("/") + "/"
        depth = base.count("/")
        folders = [
            self._folder_entry(f)
            for f in sorted(self._folders())
            if f != path and f.startswith(base) and f.count("/") == depth
        ]
        files = [
            self._file_entry(k)
            for k in sorted(self.files)
            if k.startswith(base) and k.count("/") == depth
        ]
        return folders + files

    def _under(self, path: str) -> list[str]:
        base = path.rstrip("/") + "/"
        return [k for k in self.files if k == path or k.startswith(base)]

    def handle_list_folder(self, body: dict[str, Any]) -> dict[str, Any]:
        p = _norm(body.get("path") or "/")
        if p not in self._folders():
            raise DropboxFakeError(
                f"not found: {p}",
                409,
                summary="path/not_found/..",
                error_tag="not_found",
            )
        return {
            "entries": self._children(p),
            "cursor": "c",
            "has_more": False,
        }

    def handle_get_metadata(self, body: dict[str, Any]) -> dict[str, Any]:
        p = _norm(body.get("path", ""))
        if p in self.files:
            return self._file_entry(p)
        if p in self._folders():
            return self._folder_entry(p)
        raise DropboxFakeError(
            f"not found: {p}",
            409,
            summary="path/not_found/..",
            error_tag="not_found",
        )

    def handle_upload(
        self, path: str, data: bytes, mode: Any = "add"
    ) -> dict[str, Any]:
        p = _norm(path)
        if self._file_in_way(p):
            raise DropboxFakeError(
                f"conflict: {p}", 409, summary="path/conflict/file/.."
            )
        if isinstance(mode, dict) and mode.get(".tag") == "update":
            if self.revs.get(p) != mode.get("update") or p not in self.files:
                raise DropboxFakeError(
                    f"conflict: {p}",
                    409,
                    summary="path/conflict/file/..",
                )
        elif isinstance(mode, str) and mode not in ("add", "overwrite"):
            if self.revs.get(p) != mode or p not in self.files:
                raise DropboxFakeError(
                    f"conflict: {p}",
                    409,
                    summary="path/conflict/file/..",
                )
        self.files[p] = data
        self._mint(p)
        return self._file_entry(p)

    def handle_delete_v2(self, body: dict[str, Any]) -> dict[str, Any]:
        p = _norm(body.get("path", ""))
        if p not in self.files and p not in self._folders():
            raise DropboxFakeError(
                f"not found: {p}", 409, summary="path_lookup/not_found/.."
            )
        want = body.get("parent_rev")
        if want is not None and self.revs.get(p) != want:
            raise DropboxFakeError(
                f"conflict: {p}", 409, summary="path_write/conflict/file/.."
            )
        if p in self.files:
            entry = self._file_entry(p)
            del self.files[p]
            self.revs.pop(p, None)
        else:
            entry = self._folder_entry(p)
            for key in self._under(p):
                del self.files[key]
                self.revs.pop(key, None)
            self.dirs = {d for d in self.dirs if not _within(d, p)}
        return {"metadata": entry}

    def handle_create_folder_v2(self, body: dict[str, Any]) -> dict[str, Any]:
        p = _norm(body.get("path", ""))
        if p in self.files or p in self._folders():
            raise DropboxFakeError(
                f"conflict: {p}", 409, summary="path/conflict/folder/.."
            )
        if self._file_in_way(p):
            raise DropboxFakeError(
                f"conflict: {p}", 409, summary="path/conflict/file/.."
            )
        parts = p.strip("/").split("/")
        for i in range(1, len(parts) + 1):
            self.dirs.add("/" + "/".join(parts[:i]))
        return {"metadata": self._folder_entry(p)}

    def handle_relocate(
        self, body: dict[str, Any], route: str = "move"
    ) -> dict[str, Any]:
        src = _norm(body.get("from_path", ""))
        dst = _norm(body.get("to_path", ""))
        if src not in self.files and src not in self._folders():
            raise DropboxFakeError(
                f"not found: {src}", 409, summary="from_lookup/not_found/.."
            )
        if dst in self.files or self._file_in_way(dst):
            raise DropboxFakeError(
                f"conflict: {dst}", 409, summary="to/conflict/file/.."
            )
        if dst in self._folders():
            raise DropboxFakeError(
                f"conflict: {dst}", 409, summary="to/conflict/folder/.."
            )
        moved = {k: dst + k[len(src) :] for k in self._under(src)}
        for old, new in moved.items():
            self.files[new] = self.files[old]
            self._mint(new)
            if route == "move":
                del self.files[old]
                self.revs[new] = self.revs[old]
        for d in [d for d in self.dirs if _within(d, src)]:
            self.dirs.add(dst + d[len(src) :])
            if route == "move":
                self.dirs.discard(d)
        parts = dst.strip("/").split("/")
        for i in range(1, len(parts)):
            self.dirs.add("/" + "/".join(parts[:i]))
        entry = (
            self._file_entry(dst)
            if dst in self.files
            else self._folder_entry(dst)
        )
        return {"metadata": entry}

    def handle_rpc(
        self, endpoint: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        body = body or {}
        ep = endpoint.removeprefix("/2")
        if ep == "/files/list_folder":
            return self.handle_list_folder(body)
        if ep == "/files/get_metadata":
            return self.handle_get_metadata(body)
        if ep == "/files/delete_v2":
            return self.handle_delete_v2(body)
        if ep == "/files/move_v2":
            return self.handle_relocate(body, "move")
        if ep == "/files/copy_v2":
            return self.handle_relocate(body, "copy")
        if ep == "/files/create_folder_v2":
            return self.handle_create_folder_v2(body)
        if ep == "/files/list_folder/get_latest_cursor":
            return {"cursor": "c"}
        if ep == "/files/list_folder/continue":
            return {"entries": [], "cursor": "c", "has_more": False}
        if ep == "/files/search_v2":
            return {"matches": [], "has_more": False}
        if ep == "/users/get_space_usage":
            return {
                "allocation": {".tag": "individual", "allocated": 10**12},
                "used": sum(len(v) for v in self.files.values()),
            }
        raise DropboxFakeError(
            f"unknown endpoint: {endpoint}",
            400,
            summary=f"unknown_endpoint/{ep}",
        )

    def handle_download(
        self, path: str, window: Any = None
    ) -> tuple[bytes, dict[str, str], int]:
        p = _norm(path)
        if p in self.dirs:
            raise DropboxFakeError(
                f"not file: {p}",
                409,
                summary="path/not_file/..",
                error_tag="not_file",
            )
        if p not in self.files:
            raise DropboxFakeError(
                f"not found: {p}",
                409,
                summary="path/not_found/..",
                error_tag="not_found",
            )
        data = self.files[p]
        result = {"Dropbox-API-Result": json.dumps(self._file_entry(p))}
        if window is None:
            return data, result, 200
        start = window.offset
        if start >= len(data):
            raise DropboxFakeError(
                "Range not satisfiable",
                status=416,
                headers={"Content-Range": f"bytes */{len(data)}"},
            )
        end = (
            start + window.size - 1
            if window.size is not None
            else len(data) - 1
        )
        end = min(end, len(data) - 1)
        return (
            data[start : end + 1],
            {**result, "Content-Range": f"bytes {start}-{end}/{len(data)}"},
            206,
        )
