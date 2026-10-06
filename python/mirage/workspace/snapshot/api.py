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
from pathlib import Path
from typing import TYPE_CHECKING, Any

from mirage.concurrency.limiter import run_blocking
from mirage.types import PathSpec
from mirage.vfs.s3.config import S3Config
from mirage.workspace.snapshot.manifest import split_manifest_and_blobs
from mirage.workspace.snapshot.state import to_state_dict
from mirage.workspace.snapshot.tar_io import read_tar, write_tar

try:
    from mirage.accessor.s3 import S3Accessor
    from mirage.core.s3.read import read
    from mirage.core.s3.write import write
except ImportError:
    S3Accessor = None  # type: ignore[assignment,misc]

if TYPE_CHECKING:
    from mirage.workspace.workspace import Workspace


def _s3_accessor(config: S3Config) -> "S3Accessor":
    if S3Accessor is None:
        raise ImportError(
            "An s3 snapshot requires the 's3' extra. "
            "Install with: pip install mirage-ai[s3]"
        )
    return S3Accessor(config)


def _key_path(key: str) -> PathSpec:
    return PathSpec.from_str_path("/" + key.lstrip("/"))


class _Counted:
    """A writable file-like target that counts what is written to it.

    Its ``tell`` is the count, so tarfile can write to a target that
    cannot tell, such as a pipe.
    """

    def __init__(self, target: Any) -> None:
        """Wrap a target.

        Args:
            target (Any): a writable file-like object.
        """
        self._target = target
        self.size = 0

    def write(self, data: bytes) -> int:
        """Write all of the bytes to the target and count them.

        A target that takes fewer bytes than offered is written again
        with the rest; one that answers None took them all, as file-like
        objects without a count do.

        Args:
            data (bytes): the bytes.

        Returns:
            int: how many were written.

        Raises:
            OSError: the target took none of a write.
        """
        view = memoryview(data).cast("B")
        while view:
            taken = self._target.write(view)
            if taken == 0:
                raise OSError("the snapshot target took none of a write")
            view = view[len(view) if taken is None else taken :]
        written = memoryview(data).nbytes
        self.size += written
        return written

    def tell(self) -> int:
        """Bytes written so far.

        Returns:
            int: the count.
        """
        return self.size


async def snapshot(
    ws: "Workspace",
    target,
    *,
    compress: str | None = None,
    s3: S3Config | None = None,
) -> int:
    """Serialize a Workspace to a tar archive.

    Fingerprints come from ``ws._ops.records`` (each read carries the
    backend's version marker captured at the moment of the read), so
    no live network round-trips are needed at snapshot time. Archive
    compression and host file I/O run off the workspace loop.

    Workspace.load and Workspace.copy own the inverse direction
    (construction). Snapshot does not construct Workspace — that
    keeps the dependency direction unidirectional: workspace → snapshot.

    Args:
        ws: the workspace to snapshot.
        target: filesystem path (str/Path) OR a writable file-like
            object (BytesIO, a pipe, etc.); with ``s3``, the object key.
        compress: None | "gz" | "bz2" | "xz".
        s3 (S3Config | None): an S3-like store to put the tar in, under
            its ``key_prefix``.

    Returns:
        int: the tar's size in bytes.
    """
    async with ws._quiesced():
        state = await to_state_dict(ws)
        manifest, blobs = split_manifest_and_blobs(state)
        if s3 is None and not hasattr(target, "write"):
            await run_blocking(
                write_tar, target, manifest, blobs, compress=compress
            )
            return (await run_blocking(Path(target).stat)).st_size
        if s3 is None:
            counted = _Counted(target)
            await run_blocking(
                write_tar, counted, manifest, blobs, compress=compress
            )
            return counted.size
        buffer = io.BytesIO()
        await run_blocking(
            write_tar, buffer, manifest, blobs, compress=compress
        )
    accessor = _s3_accessor(s3)
    try:
        await write(accessor, _key_path(target), buffer.getvalue())
    finally:
        await accessor.close()
    return buffer.tell()


async def read_snapshot(
    source, *, s3: S3Config | None = None, staging: Path | None = None
) -> dict[str, Any]:
    """Read a snapshot tar back into a state dict.

    Args:
        source: filesystem path (str/Path) OR a readable file-like
            object; with ``s3``, the object key.
        s3 (S3Config | None): the S3-like store the tar is in.
        staging (Path | None): a directory disk mount files are
            extracted into, so the state names them by path rather
            than holding their bytes.

    Returns:
        dict[str, Any]: the resolved state dict.
    """
    if s3 is not None:
        accessor = _s3_accessor(s3)
        try:
            source = io.BytesIO(await read(accessor, _key_path(source)))
        finally:
            await accessor.close()
    return await run_blocking(read_tar, source, staging)
