from collections.abc import Sequence

from mirage.commands.builtin.grep_pattern import (
    PATTERN_KEYS,
    merge_pattern_list,
)
from mirage.commands.builtin.rg_scan import os_error_text
from mirage.commands.builtin.utils.paths import dispatch_stat
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.core.jq import load_failure
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, eisdir, fs_error_line, fs_strerror

# The commands whose program files the executor reads before routing and
# lowers to their inline form. jq reads its -f file itself, after its
# option loop (OWN_OPTION_LOOP), so an option it refuses is reported
# first; FILE_KEYS still names its dest, so routing leaves the file out.
PROGRAM_FILE_COMMANDS = frozenset({"grep", "rg", "zgrep", "sed", "awk"})
# The dest each command's spec gives its program file.
FILE_KEYS = {
    "grep": "file",
    "rg": "file",
    "zgrep": "f",
    "sed": "f",
    "awk": "f",
    "jq": "from_file",
}

# ripgrep reads patterns from stdin once, and refuses both a second
# `-f -` and a `-` operand after it, exit 2 (14.1.1).
RG_STDIN_REREAD = (
    "rg: error reading -f/--file from stdin: stdin has already been consumed\n"
)
RG_STDIN_SEARCHED = (
    "rg: error: attempted to read patterns from stdin "
    "while also searching stdin\n"
)


def program_file_refusal(
    name: str, path: PathSpec, exc: BaseException
) -> tuple[str, int]:
    """A program file the command cannot read, in its own words and code.

    sed could not open the file, exit 4. mawk quotes the name after
    ``cannot open``, and a file it opened and then failed to read, which
    is how a directory fails, is a bare ``read error``. jq could not open
    it, and calls a directory one in words of its own. ripgrep appends
    the errno, with no space after the colon for a failed read. zgrep
    copies each pattern file with cat, so the line is cat's. grep names
    it as any operand. Every other code is 2. Pinned on
    debian:stable-slim (grep 3.11, sed 4.9, mawk 1.3.4, jq 1.7.1, ripgrep
    14.1.1, gzip 1.13).

    Args:
        name (str): a PROGRAM_FILE_COMMANDS member.
        path (PathSpec): the program file, as typed.
        exc (BaseException): why it could not be read.
    """
    shown = path.raw_path or path.virtual
    strerror = fs_strerror(exc)
    read_failed = isinstance(exc, IsADirectoryError)
    if name == "sed":
        return f"sed: couldn't open file {shown}: {strerror}\n", 4
    if name == "awk":
        if read_failed:
            return f"awk: read error ({strerror})\n", 2
        return f'awk: cannot open "{shown}" ({strerror})\n', 2
    if name == "jq":
        return f"jq: {load_failure(shown, exc)}\n", 2
    if name == "rg":
        gap = "" if read_failed else " "
        return f"rg: {shown}:{gap}{os_error_text(exc)}\n", 2
    if name == "zgrep":
        return fs_error_line("cat", path, exc), 2
    return fs_error_line(name, path, exc), 2


async def read_program_file(
    name: str, path: PathSpec, dispatch: DispatchFn
) -> bytes:
    """One program file's bytes, read through the door.

    A directory opens and fails at its read, which a keyed store's own
    read cannot tell from nothing being there, so a stat goes first; sed
    alone reads a directory as an empty script (sed 4.9).

    Args:
        name (str): a PROGRAM_FILE_COMMANDS member.
        path (PathSpec): the program file.
        dispatch (DispatchFn): the policy-gated workspace reader.
    """
    if (await dispatch_stat(dispatch, path)).type is FileType.DIRECTORY:
        if name == "sed":
            return b""
        raise eisdir(path)
    data, _ = await dispatch("read", path)
    return await materialize(data)


def program_files(name: str, flags: dict[str, FlagValue]) -> list[PathSpec]:
    """The invocation's program files, or an empty list for inline programs.

    Args:
        name (str): a PROGRAM_FILE_COMMANDS member.
        flags (dict[str, FlagValue]): spec-bound flags with PATH values.
    """
    return FlagView(flags, spec=SPECS[name]).as_paths(FILE_KEYS[name])


async def prepare_program(
    name: str,
    texts: list[str],
    flags: dict[str, FlagValue],
    stdin: ByteSource | None,
    dispatch: DispatchFn,
    operands: Sequence[PathSpec] = (),
) -> tuple[
    list[str], dict[str, FlagValue], ByteSource | None, IOResult | None
]:
    """Read program files once, before input routing or traversal fan-out.

    The program belongs to the invocation, not any input mount. Lower it
    to the command's inline form so every native sub-run sees the same
    program, including when reading it consumed stdin. GNU behavior is
    pinned in integ against debian:stable-slim (grep 3.11, sed 4.9,
    ripgrep 14.1.1).

    Args:
        name (str): a PROGRAM_FILE_COMMANDS member.
        texts (list[str]): parsed positional text operands.
        flags (dict[str, FlagValue]): spec-bound flags with PATH values.
        stdin (ByteSource | None): the invocation's original input.
        dispatch (DispatchFn): the policy-gated workspace reader.
        operands (Sequence[PathSpec]): the path operands, which rg
            checks for a `-` once `-f -` has read stdin.
    """
    fl = FlagView(flags, spec=SPECS[name])
    key = FILE_KEYS[name]
    files = program_files(name, flags)
    if not files:
        return texts, flags, stdin, None
    source = resolve_source(stdin)
    consumed = False
    # Only a literal `-` takes stdin in ripgrep's sense: `-f /dev/stdin`
    # reads the same bytes as a file, so neither refusal follows from it.
    taken = False
    pieces: list[bytes] = []
    for path in files:
        try:
            if is_stdin(path):
                if name == "rg" and path.raw_path == "-":
                    if taken:
                        return (
                            texts,
                            flags,
                            stdin,
                            IOResult(
                                exit_code=2, stderr=RG_STDIN_REREAD.encode()
                            ),
                        )
                    taken = True
                pieces.append(await materialize(source))
                consumed = True
            else:
                pieces.append(await read_program_file(name, path, dispatch))
        except FS_ERRORS as exc:
            # Match GNU's fatal script-open status; ordinary input-file
            # failures still belong to the native command handlers.
            line, code = program_file_refusal(name, path, exc)
            return (
                texts,
                flags,
                stdin,
                IOResult(exit_code=code, stderr=line.encode()),
            )
    if taken and any(p.raw_path == "-" for p in operands):
        return (
            texts,
            flags,
            stdin,
            IOResult(exit_code=2, stderr=RG_STDIN_SEARCHED.encode()),
        )
    out = dict(flags)
    out.pop(key)
    if name in ("grep", "rg", "zgrep"):
        inline = fl.as_list(PATTERN_KEYS[name])
        pattern = "\n".join(inline) if inline else None
        for data in pieces:
            pattern = merge_pattern_list(pattern, data)
        # An empty pattern-file list preserves grep's zero-pattern sentinel.
        out[key] = []
        out[PATTERN_KEYS[name]] = [] if pattern is None else [pattern]
    elif name == "sed":
        expressions = iter(fl.as_list("e"))
        scripts = iter(decode_text(data) for data in pieces)
        out["e"] = [
            next(expressions) if kind == "e" else next(scripts)
            for kind, _ in fl.occurrences("e", "f")
        ]
    else:
        texts = [
            "\n".join(decode_text(data) for data in pieces),
            *texts,
        ]
    return texts, out, source if consumed else stdin, None
