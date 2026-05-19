import io
import posixpath
import zipfile
from collections.abc import Awaitable, Callable

from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def zip_cmd(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    accessor: object = None,
    r: bool = False,
    j: bool = False,
    q: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) < 2:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    archive_path = paths[0]
    file_paths = paths[1:]
    buf = io.BytesIO()
    output_lines: list[str] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in file_paths:
            data = await read_bytes(accessor, p)
            arcname = posixpath.basename(
                p.original) if j else p.original.lstrip("/")
            zf.writestr(arcname, data)
            if not q:
                output_lines.append(f"  adding: {arcname}")
    archive = buf.getvalue()
    await write_bytes(accessor, archive_path, archive)
    stdout = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    return stdout, IOResult(writes={archive_path.original: archive})


__all__ = ["zip_cmd"]
