import io
import zipfile
from collections.abc import Awaitable, Callable

from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _resolve_dest(d: str | PathSpec | None, mount_prefix: str) -> str:
    d_str = d.original if isinstance(d, PathSpec) else d
    dest_raw = d_str if d_str else "/"
    if mount_prefix and dest_raw.startswith(mount_prefix + "/"):
        return dest_raw[len(mount_prefix):]
    if dest_raw == mount_prefix:
        return "/"
    return dest_raw


async def unzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    accessor: object = None,
    o: bool = False,
    args_l: bool = False,
    d: str | PathSpec | None = None,
    q: bool = False,
    p: bool = False,
    t: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("unzip: missing operand")
    archive_path = paths[0]
    data = await read_bytes(accessor, archive_path)
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        if args_l:
            lines = ["  Length      Name", "---------  ----"]
            for info in zf.infolist():
                lines.append(f"{info.file_size:>9}  {info.filename}")
            return ("\n".join(lines) + "\n").encode(), IOResult()
        if t:
            bad = zf.testzip()
            if bad is None:
                msg = f"No errors detected in {archive_path.original}\n"
            else:
                msg = f"first bad file: {bad}\n"
            return msg.encode(), IOResult()
        if p:
            chunks: list[bytes] = []
            for info in zf.infolist():
                if not info.is_dir():
                    chunks.append(zf.read(info.filename))
            return b"".join(chunks), IOResult()
        mount_prefix = archive_path.prefix if isinstance(
            archive_path, PathSpec) else ""
        dest = _resolve_dest(d, mount_prefix)
        writes: dict[str, bytes] = {}
        output_lines: list[str] = []
        for info in zf.infolist():
            if info.is_dir():
                continue
            content = zf.read(info.filename)
            entry_name = info.filename.lstrip("/")
            out_path = dest.rstrip("/") + "/" + entry_name
            parent = out_path.rsplit("/", 1)[0] or "/"
            if parent != "/":
                await mkdir_fn(accessor, parent, parents=True)
            await write_bytes(accessor, out_path, content)
            report_path = (mount_prefix +
                           out_path) if mount_prefix else out_path
            writes[report_path] = content
            if not q:
                output_lines.append(f"  inflating: {report_path}")
    output = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    return output, IOResult(writes=writes)


__all__ = ["unzip"]
