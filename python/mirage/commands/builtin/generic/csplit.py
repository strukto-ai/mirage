import re
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import missing_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import resolve_path


def _is_regex(pattern: str) -> bool:
    return pattern.startswith("/") and pattern.endswith("/")


def _check_line_numbers(patterns: list[str]) -> tuple[str, bool]:
    """GNU's parse-time checks on the line-number patterns, in order.

    A repeated number warns and still splits (an empty piece); a zero or
    a number below its predecessor refuses the whole run before any
    piece is written.

    Args:
        patterns (list[str]): The patterns as typed.

    Returns:
        tuple[str, bool]: The diagnostics so far, and whether to stop.
    """
    messages: list[str] = []
    last = 0
    for pattern in patterns:
        if _is_regex(pattern):
            continue
        number = int(pattern)
        if number <= 0:
            messages.append(
                f"csplit: {pattern}: line number must be greater than zero\n"
            )
            return "".join(messages), True
        if number < last:
            messages.append(
                f"csplit: line number '{pattern}' is smaller "
                f"than preceding line number, {last}\n"
            )
            return "".join(messages), True
        if number == last:
            messages.append(
                f"csplit: warning: line number '{pattern}' is "
                "the same as preceding line number\n"
            )
        last = number
    return "".join(messages), False


def _split_by_patterns(
    lines: list[str],
    patterns: list[str],
    suppress_matched: bool,
) -> tuple[list[list[str]], str | None]:
    """Cut *lines* into pieces as GNU csplit does, and report a failure.

    GNU keeps two cursors: the first line not yet written (``head``) and
    the last line it examined (``seen``, counted from 1). A regex searches
    from the line after ``seen``, so a repeated regex never matches the
    line the previous one stopped at; line N writes up to the line before
    it, an empty piece once ``head`` is past it. A line number fails when
    no line follows ``seen``, a regex when nothing matches, and the piece
    being built takes what is left. ``--suppress-matched`` drops the line
    each pattern stops at. The rest of the input is always the last
    piece, empty or not.

    Args:
        lines (list[str]): The input lines.
        patterns (list[str]): The patterns as typed.
        suppress_matched (bool): Drop the line each pattern stops at.

    Returns:
        tuple[list[list[str]], str | None]: The pieces, and GNU's
            diagnostic when the run fails.
    """
    parts: list[list[str]] = []
    head = seen = 0
    for pat in patterns:
        out_of_range = f"csplit: '{pat}': line number out of range\n"
        if _is_regex(pat):
            regex = re.compile(pat[1:-1])
            found = next(
                (
                    idx
                    for idx in range(seen, len(lines))
                    if regex.search(lines[idx])
                ),
                None,
            )
            if found is None:
                parts.append(lines[head:])
                return parts, f"csplit: '{pat}': match not found\n"
            parts.append(lines[head:found])
            head, seen = found, found + 1
        else:
            if suppress_matched and seen >= len(lines):
                parts.append([])
                return parts, out_of_range
            stop = max(head, int(pat) - 1)
            if stop > len(lines):
                parts.append(lines[head:])
                return parts, out_of_range
            parts.append(lines[head:stop])
            head, seen = stop, max(seen, stop)
            if not suppress_matched and seen >= len(lines):
                return parts, out_of_range
        if suppress_matched and head < len(lines):
            head += 1
            seen = max(seen, head)
    parts.append(lines[head:])
    return parts, None


async def csplit_generic(
    paths: list[PathSpec],
    patterns: list[str],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    prefix: str | PathSpec = "xx",
    mount_prefix: str = "",
    cwd: str = "/",
    relay: bool = False,
    digits: int = 2,
    suffix_format: str | None = None,
    keep_on_error: bool = False,
    silent: bool = False,
    suppress_matched: bool = False,
    elide_empty: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    # An output is the -f prefix, or `xx` in the working directory, plus
    # its suffix, wherever the input lives: GNU writes `xx00` to the cwd,
    # names it as it formed it (`csplit: xx00`), and stops at the first
    # one it cannot create, -k or not.
    if not patterns:
        # GNU wants FILE and a PATTERN before it opens anything.
        raise missing_operand_error(
            CommandName.CSPLIT, paths[-1].raw_path if paths else None
        )
    if isinstance(prefix, PathSpec):
        prefix_virtual, typed_prefix = prefix.virtual, prefix.raw_path
    else:
        prefix_virtual, typed_prefix = resolve_path(prefix, cwd), prefix
    suffix_fmt = suffix_format if suffix_format else f"%0{digits}d"
    # `-` is stdin. /dev/stdin would run csplit on the /dev mount, which
    # is where its pieces would land, so it stays a path.
    if paths and paths[0].raw_path != "-":
        raw = await read_bytes(paths[0])
    else:
        stdin_raw = await read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    diagnostics, refused = _check_line_numbers(list(patterns))
    if refused:
        return b"", IOResult(stderr=diagnostics.encode(), exit_code=1)
    text = raw.decode(errors="replace")
    lines = split_lines(text)
    parts, error = _split_by_patterns(lines, list(patterns), suppress_matched)
    writes: dict[str, ByteSource] = {}
    sizes: list[str] = []
    created: list[tuple[str, PathSpec]] = []
    for part in parts:
        if elide_empty and not part:
            continue
        suffix = suffix_fmt % len(sizes)
        name = typed_prefix + suffix
        data = ("\n".join(part) + "\n").encode() if part else b""
        virtual = prefix_virtual + suffix
        spec = PathSpec.from_str_path(
            virtual, mount_key(virtual, mount_prefix)
        )
        try:
            await write_bytes(spec, data)
        except FS_ERRORS as exc:
            error = f"csplit: {name}: {fs_strerror(exc)}\n"
            break
        created.append((name, spec))
        if not relay:
            # Relay writes land on whichever mount owns each path and
            # invalidate through the dispatcher; keying them here would
            # have the runner prefix them onto this mount.
            writes[spec.mount_path] = data
        sizes.append(str(len(data)))
    if error is not None:
        diagnostics += error
    if error is not None and not keep_on_error:
        # GNU removes every piece the failed run wrote unless -k keeps
        # them, so an earlier run's piece of that name is gone too.
        for name, spec in created:
            try:
                await unlink(spec)
            except FS_ERRORS as exc:
                diagnostics += f"csplit: {name}: {fs_strerror(exc)}\n"
    output = "" if silent or not sizes else "\n".join(sizes) + "\n"
    return output.encode(), IOResult(
        writes=writes,
        stderr=diagnostics.encode() or None,
        exit_code=0 if error is None else 1,
    )


__all__ = ["csplit_generic"]
