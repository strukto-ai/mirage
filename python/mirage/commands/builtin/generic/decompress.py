from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import operand_label, stdin_stream
from mirage.commands.spec.usage import read_fail_exit
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec, PolymorphicReadFn
from mirage.utils.compress import gunzip_stream
from mirage.utils.errors import FS_ERRORS, GzipDataError, fs_error_line
from mirage.utils.key_prefix import mounted_path


async def decompress_inputs(
    paths: list[PathSpec],
    *,
    command: str,
    read: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    to_stdout: bool = False,
    test_only: bool = False,
    keep: bool = False,
    write: Callable[..., Awaitable[None]] | None = None,
    unlink: Callable[..., Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Decode operands in order, preserving output and late diagnostics.

    Args:
        paths (list[PathSpec]): Expanded operands, empty for stdin.
        command (str): Diagnostic name.
        read (PolymorphicReadFn): Backend reader.
        stdin (ByteSource | None): Shared standard input cursor.
        to_stdout (bool): Write decoded bytes to stdout.
        test_only (bool): Validate without writing decoded bytes.
        keep (bool): Preserve compressed input after replacement.
        write (Callable | None): Write an in-place result.
        unlink (Callable | None): Remove a replaced input.
    """
    operands = paths or [STDIN_OPERAND]
    raw_stream = normalized_read(read)
    stream = stdin_stream(raw_stream, stdin)
    io = IOResult()
    errors: list[bytes] = []

    def report(message: bytes, code: int) -> None:
        errors.append(message)
        io.stderr = b"".join(errors)
        if io.exit_code != 1:
            io.exit_code = code

    async def run() -> AsyncIterator[bytes]:
        for path in operands:
            in_place = not (to_stdout or test_only or path.raw_path == "-")
            chunks: list[bytes] = []
            try:
                async for chunk in gunzip_stream(
                        raw_stream(path) if in_place else stream(path),
                        test_only):
                    if in_place:
                        chunks.append(chunk)
                    elif not test_only:
                        yield chunk
            except GzipDataError as exc:
                report(
                    exc.render(command, operand_label(path, "stdin")).encode(),
                    exc.exit_code)
                if exc.fatal:
                    return
                if not exc.keeps_output:
                    continue
            except FS_ERRORS as exc:
                report(
                    fs_error_line(command, path, exc).encode(),
                    read_fail_exit(command, exc))
                continue
            if in_place:
                if write is None or unlink is None:
                    raise ValueError(
                        "in-place decompression requires write and unlink")
                stripped = path.mount_path
                out_path = stripped.removesuffix(".gz") if stripped.endswith(
                    ".gz") else stripped + ".out"
                data = b"".join(chunks)
                await write(mounted_path(path, out_path), data)
                io.writes[out_path] = data
                if not keep:
                    await unlink(path)

    body = run()
    if test_only or any(not (to_stdout or p.raw_path == "-")
                        for p in operands):
        return (await materialize(body)) or None, io
    return body, io
