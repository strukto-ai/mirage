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
import os
import shutil
import tarfile
from pathlib import Path
from typing import Any, Literal

from mirage.core.disk.utils import open_regular
from mirage.types import VFSName
from mirage.workspace.snapshot.keys import MountKey, StateKey, VFSStateKey
from mirage.workspace.snapshot.manifest import resolve_manifest
from mirage.workspace.snapshot.utils import BLOB_REF_KEY, is_safe_blob_path

_MANIFEST_NAME = "manifest.json"

_COMPRESS_MODES: dict[str | None, Literal["w", "w:gz", "w:bz2", "w:xz"]] = {
    None: "w",
    "gz": "w:gz",
    "bz2": "w:bz2",
    "xz": "w:xz",
}


def write_tar(
    target,
    manifest: dict[str, Any],
    blobs: dict[str, bytes | Path],
    *,
    compress: str | None = None,
) -> None:
    """Write manifest + blobs as a tar.

    A blob that is a host path is streamed from its file, so the tar
    never holds more than one chunk of it in memory.

    Args:
        target: filesystem path (str/Path) OR a writable file-like
            object with a `write` method (BytesIO, etc.).
        manifest: JSON-serializable dict.
        blobs: {tar_path: bytes or host path} side-files.
        compress: None | "gz" | "bz2" | "xz".
    """
    if compress not in _COMPRESS_MODES:
        raise ValueError(
            f"Unknown compress mode: {compress!r}. "
            f"Use one of: {sorted(k for k in _COMPRESS_MODES if k)}"
        )
    mode = _COMPRESS_MODES[compress]
    if hasattr(target, "write"):
        tar = tarfile.open(fileobj=target, mode=mode)
    else:
        tar = tarfile.open(str(target), mode)
    with tar:
        manifest_bytes = json.dumps(
            manifest, indent=2, default=_json_default
        ).encode("utf-8")
        _add(tar, _MANIFEST_NAME, manifest_bytes)
        for tar_path, data in blobs.items():
            _add(tar, tar_path, data)


def read_tar(source, staging: Path | None = None) -> dict[str, Any]:
    """Read a tar produced by write_tar; return a resolved state dict.

    With ``staging``, each disk mount's files are extracted there in
    chunks and come back as host paths, so a restore copies them into
    place instead of holding them in memory; the caller removes the
    directory once the state is loaded.

    Args:
        source: filesystem path (str/Path) OR a readable file-like
            object with a `read` method.
        staging (Path | None): a directory for disk mount files.
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
        if staging is not None:
            _stage_disk_files(tar, manifest, staging)
        return resolve_manifest(manifest, _make_reader(tar))


def _stage_disk_files(
    tar: tarfile.TarFile, manifest: dict[str, Any], staging: Path
) -> None:
    """Extract every disk mount's files under ``staging``.

    Each blob reference in a disk mount's files becomes the host path
    it was extracted to, which ``resolve_manifest`` leaves alone.

    Args:
        tar (tarfile.TarFile): the open snapshot.
        manifest (dict[str, Any]): the parsed manifest, rewritten.
        staging (Path): where the files go.
    """
    for mount in manifest.get(StateKey.MOUNTS) or []:
        vfs_state = mount.get(MountKey.VFS_STATE) or {}
        if vfs_state.get(VFSStateKey.TYPE) != VFSName.DISK:
            continue
        files = vfs_state.get(VFSStateKey.FILES) or {}
        for rel, ref in files.items():
            if not isinstance(ref, dict) or set(ref) != {BLOB_REF_KEY}:
                continue
            blob_path = ref[BLOB_REF_KEY]
            src = _make_reader(tar, stream=True)(blob_path)
            target = (staging / blob_path).resolve()
            if not target.is_relative_to(staging.resolve()):
                src.close()
                raise ValueError(f"Unsafe blob path: {blob_path!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
            files[rel] = target


def _make_reader(tar, stream: bool = False):
    def reader(blob_path: str):
        if not is_safe_blob_path(blob_path):
            raise ValueError(f"Unsafe blob path: {blob_path!r}")
        try:
            member = tar.getmember(blob_path)
        except KeyError as exc:
            raise ValueError(
                f"Manifest references missing blob: {blob_path!r}"
            ) from exc
        f = tar.extractfile(member)
        if f is None:
            raise ValueError(f"Blob unreadable: {blob_path!r}")
        return f if stream else f.read()

    return reader


def _add(tar: tarfile.TarFile, name: str, data: bytes | Path) -> None:
    info = tarfile.TarInfo(name=name)
    info.mode = 0o644
    if isinstance(data, Path):
        with open_regular(data) as f:
            info.size = os.fstat(f.fileno()).st_size
            tar.addfile(info, f)
        return
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def _json_default(obj):
    # StrEnum members serialize as their string value (already happens
    # since StrEnum inherits from str), but bytes leftover in the
    # manifest are a programmer error — they should have been split
    # to blob refs earlier.
    if isinstance(obj, bytes):
        raise TypeError(
            "Bytes leftover in manifest — split_manifest_and_blobs "
            "must replace every bytes value with a blob ref"
        )
    raise TypeError(
        f"Object of type {type(obj).__name__} not JSON serializable"
    )
