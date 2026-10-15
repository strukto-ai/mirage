from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.checksum import StoredDigest, hash_source
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    split_readable,
)
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.config import CommandOpts
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


async def md5(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """BSD md5 over the operands, or stdin.

    Args:
        paths (list[PathSpec]): the operands.
        read_stream (PolymorphicReadFn): bound reader.
        stdin (ByteSource | None): the line's input.
        stored (StoredDigest | None): the mount's stored digest, asked
            before an operand is read.
    """
    io = IOResult()
    read = normalized_read(read_stream)
    sources: list[tuple[PathSpec, str | None, ByteSource]] = []
    for p in paths:
        try:
            digest = (
                await stored(p, "md5")
                if stored is not None and not is_stdin(p)
                else None
            )
            sources.append((p, digest, read(p) if digest is None else b""))
        except FS_ERRORS as exc:
            io.stderr = await materialize(io.stderr) + encode_text(
                fs_error_line("md5", p, exc)
            )
            io.exit_code = 1

    async def output() -> AsyncIterator[bytes]:
        if not paths:
            digest = await hash_source(resolve_source(stdin), "md5")
            yield f"{digest}  -\n".encode()
            return
        for p, cached_digest, source in sources:
            try:
                digest = (
                    cached_digest
                    if cached_digest is not None
                    else await hash_source(source, "md5")
                )
                yield f"{digest}  {p.raw_path}\n".encode()
            except FS_ERRORS as exc:
                io.stderr = await materialize(io.stderr) + encode_text(
                    fs_error_line("md5", p, exc)
                )
                io.exit_code = 1

    return output(), io


async def md5_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
    stored: StoredDigest | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run BSD md5 over resolved operands; mirrors md5Generic.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by md5.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
        stored (StoredDigest | None): the mount's stored digest.
    """
    readable, err = await split_readable(paths, stat, "md5")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await md5(
            readable,
            read_stream=stream,
            stdin=opts.stdin,
            stored=stored,
        ),
        err,
    )


__all__ = ["md5", "md5_generic"]
