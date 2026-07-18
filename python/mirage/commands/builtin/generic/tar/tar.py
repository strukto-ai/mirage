import fnmatch
import io
import tarfile
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.generic.tar.constants import (READ_MODES,
                                                           WRITE_MODES)
from mirage.commands.builtin.generic.tar.types import (CompressionSuffix,
                                                       ReadMode, WriteMode)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _excluded(name: str, pattern: str) -> bool:
    base = name.split("/")[-1]
    return fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(base, pattern)


def _compression_suffix(z: bool, j: bool, J: bool) -> CompressionSuffix:
    if z:
        return ":gz"
    if j:
        return ":bz2"
    if J:
        return ":xz"
    return ""


def _write_mode(suffix: CompressionSuffix) -> WriteMode:
    return WRITE_MODES[suffix]


def _read_mode(suffix: CompressionSuffix) -> ReadMode:
    return READ_MODES[suffix]


async def _create_archive(
    paths: list[PathSpec],
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    exclude: str | None,
    verbose: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    buf = io.BytesIO()
    names: list[str] = []
    with tarfile.open(fileobj=buf, mode=_write_mode(mode_suffix)) as tf:
        for p in paths:
            name = p.virtual.lstrip("/")
            if exclude and _excluded(name, exclude):
                continue
            data = await read_bytes(p)
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
            names.append(name)
    archive = buf.getvalue()
    await write_bytes(archive_path, archive)
    stdout = ("\n".join(names) + "\n").encode() if verbose and names else None
    return stdout, IOResult(writes={archive_path.mount_path: archive})


async def _list_archive(
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(archive_path)
    with tarfile.open(fileobj=io.BytesIO(data),
                      mode=_read_mode(mode_suffix)) as tf:
        names = tf.getnames()
    return ("\n".join(names) + "\n").encode(), IOResult()


async def _extract_archive(
    archive_path: PathSpec,
    dest_path: str,
    mode_suffix: CompressionSuffix,
    strip_n: int,
    verbose: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(archive_path)
    writes: dict[str, ByteSource] = {}
    names: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(data),
                      mode=_read_mode(mode_suffix)) as tf:
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
                await mkdir_fn(PathSpec.from_str_path(parent), parents=True)
            await write_bytes(PathSpec.from_str_path(out_path), content)
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
    archive = f if f else None
    dest_path = C.mount_path if C else "/"
    mode_suffix = _compression_suffix(z, j, J)
    strip_n = int(strip_components) if strip_components else 0
    if c:
        if archive is None:
            raise ValueError("tar: -f is required")
        return await _create_archive(paths, archive, mode_suffix, exclude, v,
                                     read_bytes, write_bytes)
    if t:
        if archive is None:
            raise ValueError("tar: -f is required")
        return await _list_archive(archive, mode_suffix, read_bytes)
    if x:
        if archive is None:
            raise ValueError("tar: -f is required")
        return await _extract_archive(archive, dest_path, mode_suffix, strip_n,
                                      v, read_bytes, write_bytes, mkdir_fn)
    raise ValueError("tar: must specify -c, -x, or -t")


__all__ = ["tar"]
