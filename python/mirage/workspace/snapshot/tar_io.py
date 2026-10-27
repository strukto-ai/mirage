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
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from typing import IO, Any, BinaryIO, NoReturn, Protocol, cast

from mirage.core.disk.utils import open_regular
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view, text_view
from mirage.types import JsonValue, VFSName
from mirage.workspace.snapshot.keys import MountKey, StateKey, VFSStateKey
from mirage.workspace.snapshot.manifest import resolve_manifest
from mirage.workspace.snapshot.utils import BLOB_REF_KEY

_MANIFEST_NAME = "manifest.json"

_CODECS: dict[str | None, str | None] = {
    None: None,
    "gz": "gzip",
    "bz2": "bzip2",
    "xz": "xz",
}

# The name the archive goes by inside the tar engine.
_ARCHIVE = "snapshot.tar"

_CHUNK = 256 * 1024


class Writable(Protocol):
    """The byte sink a snapshot can stream into."""

    def write(self, data: bytes | memoryview, /) -> int | None: ...


def write_tar(
    target: str | Path | Writable,
    manifest: dict[str, Any],
    blobs: dict[str, bytes | Path],
    *,
    compress: str | None = None,
) -> None:
    """Write manifest + blobs as a tar, through mirage-rs's tar.

    A blob that is a host path is streamed from its file, opened only
    while it is read, so the tar never holds more than one chunk of it
    in memory.

    Args:
        target (str | Path | Writable): filesystem path OR a writable file-like
            object with a `write` method (BytesIO, etc.).
        manifest (dict[str, Any]): JSON-serializable dict.
        blobs (dict[str, bytes | Path]): side-files keyed by tar path.
        compress (str | None): None | "gz" | "bz2" | "xz".
    """
    if compress not in _CODECS:
        raise ValueError(
            f"Unknown compress mode: {compress!r}. "
            f"Use one of: {sorted(k for k in _CODECS if k)}"
        )
    manifest_bytes = json.dumps(
        manifest, indent=2, default=_json_default
    ).encode("utf-8")
    entries = [(_MANIFEST_NAME, manifest_bytes), *blobs.items()]
    members: list[JsonValue] = [
        {
            "name": byte_view(name),
            "path": byte_view(name),
            "operand": operand,
            "size": _size(data),
        }
        for operand, (name, data) in enumerate(entries, start=2)
    ]
    inputs: dict[int, IO[bytes]] = {}
    with ExitStack() as stack:
        sink = cast(
            Writable,
            target
            if hasattr(target, "write")
            else stack.enter_context(open(target, "wb")),
        )
        stack.callback(lambda: [f.close() for f in inputs.values()])

        def serve(
            request: dict[str, JsonValue], data: bytes
        ) -> tuple[dict[str, JsonValue], bytes]:
            if request["op"] == "write":
                sink.write(data)
            if request["op"] != "read":
                return {}, b""
            fd = cast(int, request["fd"])
            if "operand" in request:
                blob = entries[cast(int, request["operand"]) - 2][1]
                inputs[fd] = (
                    open_regular(blob)
                    if isinstance(blob, Path)
                    else io.BytesIO(blob)
                )
            chunk = inputs[fd].read(_CHUNK)
            if len(chunk) == _CHUNK:
                return {}, chunk
            inputs.pop(fd).close()
            return {"end": True}, chunk

        _run(
            {
                "mode": "create",
                "archive": _ARCHIVE,
                "output": _ARCHIVE,
                "codec": _CODECS[compress],
                "members": members,
            },
            serve,
        )


def read_tar(
    source: str | Path | BinaryIO, staging: Path | None = None
) -> dict[str, Any]:
    """Read a tar produced by write_tar; return a resolved state dict.

    mirage-rs's tar reads it once, in order, sniffing its compressor;
    a member the manifest names no blob for is read past, not held.
    With ``staging``, each disk mount's files are written there as they
    arrive and come back as host paths, so a restore copies them into
    place instead of holding them in memory; the caller removes the
    directory once the state is loaded.

    Args:
        source (str | Path | BinaryIO): filesystem path OR a readable file-like
            object with a `read` method.
        staging (Path | None): a directory for disk mount files.
    """
    held: dict[str, bytearray] = {}
    staged: dict[str, Path] = {}
    files: dict[str, IO[bytes]] = {}
    manifest: dict[str, Any] | None = None
    wanted: set[str] = set()
    disk: set[str] = set()
    with ExitStack() as stack:
        src = cast(
            BinaryIO,
            source
            if hasattr(source, "read")
            else stack.enter_context(open(source, "rb")),
        )
        stack.callback(lambda: [f.close() for f in files.values()])

        def begin(name: str) -> None:
            nonlocal manifest, wanted, disk
            if name == _MANIFEST_NAME:
                held[name] = bytearray()
                return
            if manifest is None:
                manifest = _manifest_of(held)
                wanted = _blob_paths(manifest)
                disk = {blob for _, _, blob in _disk_file_refs(manifest)}
            if name not in wanted:
                return
            if staging is None or name not in disk:
                held[name] = bytearray()
                return
            target = (staging / name).resolve()
            if not target.is_relative_to(staging.resolve()):
                raise ValueError(f"Unsafe blob path: {name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            files[name] = target.open("wb")
            staged[name] = target

        def serve(
            request: dict[str, JsonValue], data: bytes
        ) -> tuple[dict[str, JsonValue], bytes]:
            op = request["op"]
            if op == "read":
                chunk = src.read(_CHUNK)
                return ({} if chunk else {"end": True}), chunk
            if op == "stat":
                return {"kind": "dir"}, b""
            path = request.get("path")
            if op not in ("write", "flush") or not isinstance(path, str):
                return {}, b""
            name = text_view(path).lstrip("/")
            if request.get("create") or request.get("whole"):
                begin(name)
            if name in files:
                files[name].write(data)
                if op == "flush" or request.get("whole"):
                    files.pop(name).close()
            elif name in held:
                held[name] += data
            return {}, b""

        _run({"mode": "extract", "archive": _ARCHIVE, "base": ""}, serve)
    if manifest is None:
        manifest = _manifest_of(held)
    for files_map, rel, blob_path in _disk_file_refs(manifest):
        if blob_path in staged:
            files_map[rel] = staged[blob_path]

    def reader(blob_path: str) -> bytes:
        if blob_path not in held:
            raise ValueError(
                f"Manifest references missing blob: {blob_path!r}"
            )
        return bytes(held[blob_path])

    return resolve_manifest(manifest, reader)


def _run(
    config: dict[str, JsonValue],
    serve: Callable[
        [dict[str, JsonValue], bytes], tuple[dict[str, JsonValue], bytes]
    ],
) -> None:
    """Run mirage-rs's tar to its end, ``serve`` answering each request.

    Args:
        config (dict[str, JsonValue]): the run.
        serve (Callable): the host, answering a request and its bytes.

    Raises:
        ValueError: tar refused the archive, in its own words.
    """
    stream = open_stream("tar", config)
    while True:
        while stream.busy():
            stream.drain()
        taken = stream.request()
        if taken is None:
            break
        stream.respond(*serve(*taken))
    stream.finish()
    if stream.status() != 0:
        raise ValueError(stream.take_stderr().decode(errors="replace").strip())


def _manifest_of(held: dict[str, bytearray]) -> dict[str, Any]:
    """The manifest, the archive's first member, parsed.

    Args:
        held (dict[str, bytearray]): the members read into memory.
    """
    if _MANIFEST_NAME not in held:
        raise ValueError(f"{_MANIFEST_NAME} missing or unreadable")
    return cast(dict[str, Any], json.loads(held[_MANIFEST_NAME]))


def _blob_paths(manifest: dict[str, Any]) -> set[str]:
    """Every blob path the manifest names, each checked safe.

    Args:
        manifest (dict[str, Any]): the parsed manifest.
    """
    paths: set[str] = set()

    def note(path: str) -> bytes:
        paths.add(path)
        return b""

    resolve_manifest(manifest, note)
    return paths


def _disk_file_refs(
    manifest: dict[str, Any],
) -> list[tuple[dict[str, Any], str, str]]:
    """Every disk mount file's blob reference: the files map holding it,
    its key there and its tar path, which a restore stages on disk.

    Args:
        manifest (dict[str, Any]): the parsed manifest.
    """
    refs = []
    for mount in manifest.get(StateKey.MOUNTS) or []:
        vfs_state = mount.get(MountKey.VFS_STATE) or {}
        if vfs_state.get(VFSStateKey.TYPE) != VFSName.DISK:
            continue
        files = vfs_state.get(VFSStateKey.FILES) or {}
        for rel, ref in files.items():
            if isinstance(ref, dict) and set(ref) == {BLOB_REF_KEY}:
                refs.append((files, rel, ref[BLOB_REF_KEY]))
    return refs


def _size(data: bytes | Path) -> int:
    """A blob's size; a host file is refused when no longer regular.

    Args:
        data (bytes | Path): the blob or the host file holding it.
    """
    if isinstance(data, bytes):
        return len(data)
    with open_regular(data) as f:
        return os.fstat(f.fileno()).st_size


def _json_default(obj: Any) -> NoReturn:
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
