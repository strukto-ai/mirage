import fnmatch
import io
import zipfile
from collections.abc import Awaitable, Callable

from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

# Info-ZIP's wording and spacing, verbatim (two spaces after the colon).
CAUTION_PREFIX = "caution: filename not matched:  "


def _resolve_dest(d: str | PathSpec | None, mount_prefix: str) -> str:
    d_str = d.virtual if isinstance(d, PathSpec) else d
    dest_raw = d_str if d_str else "/"
    if mount_prefix and dest_raw.startswith(mount_prefix + "/"):
        return dest_raw[len(mount_prefix):]
    if dest_raw == mount_prefix:
        return "/"
    return dest_raw


def _spec_index(name: bytes, members: tuple[bytes, ...]) -> int | None:
    for i, member in enumerate(members):
        if fnmatch.fnmatchcase(name, member):
            return i
    return None


def _select(
        infos: list[zipfile.ZipInfo],
        members: tuple[str, ...]) -> tuple[list[zipfile.ZipInfo], list[str]]:
    if not members:
        return infos, []
    # Info-ZIP matches filespecs against the encoded name, so `?` stands
    # for one byte, not one code point: `?.txt` misses `é.txt` and
    # `??.txt` hits it.
    encoded = tuple(member.encode() for member in members)
    # Info-ZIP walks the archive in order and charges each entry to the
    # first filespec that matches it, so a spec shadowed by an earlier
    # one reports "filename not matched" even when its file was printed.
    hit = [False] * len(members)
    selected: list[zipfile.ZipInfo] = []
    for info in infos:
        idx = _spec_index(info.filename.encode(), encoded)
        if idx is None:
            continue
        hit[idx] = True
        selected.append(info)
    unmatched = [m for m, h in zip(members, hit) if not h]
    return selected, unmatched


def _cautions(unmatched: list[str]) -> str:
    return "".join(CAUTION_PREFIX + member + "\n" for member in unmatched)


async def unzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    members: tuple[str, ...] = (),
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
    data = await read_bytes(archive_path)
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        selected, unmatched = _select(zf.infolist(), members)
        if args_l:
            lines = ["  Length      Name", "---------  ----"]
            for info in selected:
                lines.append(f"{info.file_size:>9}  {info.filename}")
            listing = ("\n".join(lines) + "\n").encode()
            # GNU -l prints no caution lines and only exits 11 when the
            # member list matched nothing at all.
            if members and not selected:
                return listing, IOResult(exit_code=11)
            return listing, IOResult()
        if t:
            if members:
                bad = None
                for info in selected:
                    if info.is_dir():
                        continue
                    try:
                        zf.read(info)
                    except zipfile.BadZipFile:
                        bad = info.filename
                        break
            else:
                bad = zf.testzip()
            if bad is not None:
                return f"first bad file: {bad}\n".encode(), IOResult()
            if unmatched:
                # GNU -t reports unmatched members on stdout and counts
                # them as errors.
                msg = _cautions(unmatched) + (
                    f"At least one error was detected in "
                    f"{archive_path.virtual}.\n")
                return msg.encode(), IOResult(exit_code=11)
            msg = f"No errors detected in {archive_path.virtual}\n"
            return msg.encode(), IOResult()
        if p:
            chunks: list[bytes] = []
            for info in selected:
                if not info.is_dir():
                    # Read the selected ZipInfo, not its name: a name
                    # lookup resolves every duplicate to the last one.
                    chunks.append(zf.read(info))
            if unmatched:
                return b"".join(chunks), IOResult(
                    exit_code=11, stderr=_cautions(unmatched).encode())
            return b"".join(chunks), IOResult()
        mount_prefix = mount_prefix_of(
            archive_path.virtual, archive_path.resource_path) if isinstance(
                archive_path, PathSpec) else ""
        dest = _resolve_dest(d, mount_prefix)
        writes: dict[str, ByteSource] = {}
        output_lines: list[str] = []
        for info in selected:
            entry_name = info.filename.lstrip("/")
            out_path = dest.rstrip("/") + "/" + entry_name.rstrip("/")
            report_path = (mount_prefix +
                           out_path) if mount_prefix else out_path
            if info.is_dir():
                # A directory entry is the only record an empty
                # directory leaves, so it has to be recreated even
                # though nothing is written inside it.
                await mkdir_fn(PathSpec.from_str_path(out_path), parents=True)
                if not q:
                    output_lines.append(f"   creating: {report_path}/")
                continue
            content = zf.read(info)
            parent = out_path.rsplit("/", 1)[0] or "/"
            if parent != "/":
                await mkdir_fn(PathSpec.from_str_path(parent), parents=True)
            await write_bytes(PathSpec.from_str_path(out_path), content)
            writes[out_path] = content
            if not q:
                output_lines.append(f"  inflating: {report_path}")
    output = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    if unmatched:
        return output, IOResult(exit_code=11,
                                stderr=_cautions(unmatched).encode(),
                                writes=writes)
    return output, IOResult(writes=writes)


__all__ = ["unzip"]
