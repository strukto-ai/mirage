import fnmatch
import io
import tarfile
from collections.abc import Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _excluded(name: str, pattern: str) -> bool:
    base = name.split("/")[-1]
    return fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(base, pattern)


def _compression_suffix(z: bool, j: bool, J: bool) -> str:
    if z:
        return ":gz"
    if j:
        return ":bz2"
    if J:
        return ":xz"
    return ""


async def _create_archive(
    paths: list[PathSpec],
    archive_path: str,
    mode_suffix: str,
    exclude: str | None,
    verbose: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    accessor: Accessor,
) -> tuple[ByteSource | None, IOResult]:
    buf = io.BytesIO()
    names: list[str] = []
    with tarfile.open(fileobj=buf, mode=f"w{mode_suffix}") as tf:
        for p in paths:
            name = p.virtual.lstrip("/")
            if exclude and _excluded(name, exclude):
                continue
            data = await read_bytes(accessor, p)
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
            names.append(name)
    archive = buf.getvalue()
    await write_bytes(accessor, archive_path, archive)
    stdout = ("\n".join(names) + "\n").encode() if verbose and names else None
    return stdout, IOResult(writes={archive_path: archive})


async def _list_archive(
    archive_path: str,
    mode_suffix: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor,
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(accessor, archive_path)
    with tarfile.open(fileobj=io.BytesIO(data), mode=f"r{mode_suffix}") as tf:
        names = tf.getnames()
    return ("\n".join(names) + "\n").encode(), IOResult()


async def _extract_archive(
    archive_path: str,
    dest_path: str,
    mode_suffix: str,
    strip_n: int,
    verbose: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    accessor: Accessor,
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(accessor, archive_path)
    writes: dict[str, bytes] = {}
    names: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(data), mode=f"r{mode_suffix}") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            extracted = tf.extractfile(member)
            if not extracted:
                continue
            content = extracted.read()
            name_parts = member.name.split("/")
            if strip_n > 0:
                name_parts = name_parts[strip_n:]
            if not name_parts:
                continue
            out_path = dest_path.rstrip("/") + "/" + "/".join(name_parts)
            parent = out_path.rsplit("/", 1)[0] or "/"
            if parent != "/":
                await mkdir_fn(accessor, parent, parents=True)
            await write_bytes(accessor, out_path, content)
            writes[out_path] = content
            names.append(member.name)
    stdout = ("\n".join(names) + "\n").encode() if verbose and names else None
    return stdout, IOResult(writes=writes)


async def tar(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
    c: bool = False,
    x: bool = False,
    t: bool = False,
    z: bool = False,
    j: bool = False,
    J: bool = False,
    v: bool = False,
    f: PathSpec | None = None,
    C: PathSpec | None = None,
    strip_components: str | None = None,
    exclude: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    archive_path = f.mount_path if f else None
    dest_path = C.mount_path if C else "/"
    mode_suffix = _compression_suffix(z, j, J)
    strip_n = int(strip_components) if strip_components else 0
    if c:
        if not archive_path:
            raise ValueError("tar: -f is required")
        return await _create_archive(paths, archive_path, mode_suffix, exclude,
                                     v, read_bytes, write_bytes, accessor)
    if t:
        if not archive_path:
            raise ValueError("tar: -f is required")
        return await _list_archive(archive_path, mode_suffix, read_bytes,
                                   accessor)
    if x:
        if not archive_path:
            raise ValueError("tar: -f is required")
        return await _extract_archive(archive_path, dest_path, mode_suffix,
                                      strip_n, v, read_bytes, write_bytes,
                                      mkdir_fn, accessor)
    raise ValueError("tar: must specify -c, -x, or -t")


__all__ = ["tar"]
