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

import io
import json
import tarfile
from typing import Literal

from mirage.workspace.snapshot.manifest import resolve_manifest
from mirage.workspace.snapshot.utils import is_safe_blob_path

_MANIFEST_NAME = "manifest.json"

_COMPRESS_MODES: dict[str | None, Literal["w", "w:gz", "w:bz2", "w:xz"]] = {
    None: "w",
    "gz": "w:gz",
    "bz2": "w:bz2",
    "xz": "w:xz"
}


def write_tar(target,
              manifest: dict,
              blobs: dict[str, bytes],
              *,
              compress: str | None = None) -> None:
    """Write manifest + blobs as a tar.

    Args:
        target: filesystem path (str/Path) OR a writable file-like
            object with a `write` method (BytesIO, etc.).
        manifest: JSON-serializable dict.
        blobs: {tar_path: bytes} side-files.
        compress: None | "gz" | "bz2" | "xz".
    """
    if compress not in _COMPRESS_MODES:
        raise ValueError(
            f"Unknown compress mode: {compress!r}. "
            f"Use one of: {sorted(k for k in _COMPRESS_MODES if k)}")
    mode = _COMPRESS_MODES[compress]
    if hasattr(target, "write"):
        tar = tarfile.open(fileobj=target, mode=mode)
    else:
        tar = tarfile.open(str(target), mode)
    with tar:
        manifest_bytes = json.dumps(manifest, indent=2,
                                    default=_json_default).encode("utf-8")
        _add(tar, _MANIFEST_NAME, manifest_bytes)
        for tar_path, data in blobs.items():
            _add(tar, tar_path, data)


def read_tar(source) -> dict:
    """Read a tar produced by write_tar; return a resolved state dict.

    Args:
        source: filesystem path (str/Path) OR a readable file-like
            object with a `read` method.
    """
    if hasattr(source, "read"):
        tar = tarfile.open(fileobj=source, mode="r:*")
    else:
        tar = tarfile.open(str(source), "r:*")
    with tar:
        member = tar.getmember(_MANIFEST_NAME)
        f = tar.extractfile(member)
        if f is None:
            raise ValueError(f"{_MANIFEST_NAME} missing or unreadable")
        manifest = json.loads(f.read().decode("utf-8"))
        return resolve_manifest(manifest, _make_reader(tar))


def _make_reader(tar):

    def reader(blob_path: str) -> bytes:
        if not is_safe_blob_path(blob_path):
            raise ValueError(f"Unsafe blob path: {blob_path!r}")
        try:
            member = tar.getmember(blob_path)
        except KeyError as exc:
            raise ValueError(
                f"Manifest references missing blob: {blob_path!r}") from exc
        f = tar.extractfile(member)
        if f is None:
            raise ValueError(f"Blob unreadable: {blob_path!r}")
        return f.read()

    return reader


def _add(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


def _json_default(obj):
    # StrEnum members serialize as their string value (already happens
    # since StrEnum inherits from str), but bytes leftover in the
    # manifest are a programmer error — they should have been split
    # to blob refs earlier.
    if isinstance(obj, bytes):
        raise TypeError(
            "Bytes leftover in manifest — split_manifest_and_blobs "
            "must replace every bytes value with a blob ref")
    raise TypeError(
        f"Object of type {type(obj).__name__} not JSON serializable")
