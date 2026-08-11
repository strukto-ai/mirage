import io
import tarfile
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.generic.archive.walk import (DirProbe, StatFn,
                                                          WalkFn)
from mirage.commands.builtin.generic.tar.constants import (READ_MODES,
                                                           WRITE_MODES)
from mirage.commands.builtin.generic.tar.create import plan_create
from mirage.commands.builtin.generic.tar.types import (CompressionSuffix,
                                                       CreateResult, Member,
                                                       ReadMode, WriteMode)
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec


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


def _stderr(lines: list[str]) -> bytes:
    return ("\n".join(lines) + "\n").encode() if lines else b""


def _info(member: Member, size: int) -> tarfile.TarInfo:
    """The header for one member, typed the way its kind demands.

    Args:
        member (Member): the planned entry.
        size (int): byte length of the content, 0 for a dir or a link.
    """
    info = tarfile.TarInfo(name=member.name)
    info.size = size
    if member.kind == "dir":
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
    elif member.kind == "link":
        info.type = tarfile.SYMTYPE
        info.linkname = member.target
        info.mode = 0o777
    return info


async def _create_archive(
    plan: CreateResult,
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    verbose: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    buf = io.BytesIO()
    names: list[str] = []
    with tarfile.open(fileobj=buf, mode=_write_mode(mode_suffix)) as tf:
        for member in plan.members:
            data = b""
            if member.path is not None:
                data = await read_bytes(member.path)
            tf.addfile(_info(member, len(data)), io.BytesIO(data))
            names.append(member.name)
    archive = buf.getvalue()
    await write_bytes(archive_path, archive)
    stdout = ("\n".join(names) + "\n").encode() if verbose and names else None
    return stdout, IOResult(writes={archive_path.mount_path: archive},
                            stderr=_stderr(list(plan.notices)),
                            exit_code=plan.exit_code)


async def _list_archive(
    archive_path: PathSpec,
    mode_suffix: CompressionSuffix,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    data = await read_bytes(archive_path)
    with tarfile.open(fileobj=io.BytesIO(data),
                      mode=_read_mode(mode_suffix)) as tf:
        names = [
            member.name + "/" if member.isdir() else member.name
            for member in tf.getmembers()
        ]
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
            # A symlink member has no bytes to write and no namespace to
            # write into from here (links are workspace state, not the
            # backend's), so extraction skips it rather than dropping an
            # empty file where a link belongs.
            if not member.isfile() and not member.isdir():
                continue
            name_parts = member.name.rstrip("/").split("/")
            if strip_n > 0:
                name_parts = name_parts[strip_n:]
            if not name_parts or name_parts == [""]:
                continue
            out_path = dest_path.rstrip("/") + "/" + "/".join(name_parts)
            if member.isdir():
                # A directory member is the only record an empty
                # directory leaves, so it has to be recreated even
                # though nothing is written inside it.
                await mkdir_fn(PathSpec.from_str_path(out_path), parents=True)
                names.append(member.name.rstrip("/") + "/")
                continue
            extracted = tf.extractfile(member)
            if not extracted:
                continue
            content = extracted.read()
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
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    c: bool = False,
    x: bool = False,
    t: bool = False,
    z: bool = False,
    j: bool = False,
    J: bool = False,
    v: bool = False,
    h: bool = False,
    f: PathSpec | None = None,
    C: list[PathSpec] | None = None,
    strip_components: str | None = None,
    exclude: str | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
) -> tuple[ByteSource | None, IOResult]:
    archive = f if f else None
    # Only the last -C is a destination; create checks every one.
    dest_path = C[-1].mount_path if C else "/"
    mode_suffix = _compression_suffix(z, j, J)
    strip_n = int(strip_components) if strip_components else 0
    if c:
        if archive is None:
            raise ValueError("tar: -f is required")
        plan = await plan_create(paths,
                                 archive=archive,
                                 exclude=exclude,
                                 dereference=h,
                                 stat=stat,
                                 walk=walk,
                                 is_dir=is_dir,
                                 directories=C or [],
                                 links=links,
                                 mounts=mounts)
        if not plan.write:
            return None, IOResult(exit_code=plan.exit_code,
                                  stderr=_stderr(list(plan.notices)))
        return await _create_archive(plan, archive, mode_suffix, v, read_bytes,
                                     write_bytes)
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
