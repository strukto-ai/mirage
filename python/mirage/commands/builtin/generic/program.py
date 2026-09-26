from collections.abc import Sequence

from mirage.commands.builtin.grep_pattern import (PATTERN_KEYS,
                                                  merge_pattern_list)
from mirage.commands.builtin.utils.stream import is_stdin, resolve_source
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line

PROGRAM_FILE_COMMANDS = frozenset({"grep", "rg", "sed", "awk", "jq"})
# The dest each command's spec gives its program file.
FILE_KEYS = {
    "grep": "file",
    "rg": "file",
    "sed": "f",
    "awk": "f",
    "jq": "from_file"
}

# ripgrep reads patterns from stdin once, and refuses both a second
# `-f -` and a `-` operand after it, exit 2 (14.1.1).
RG_STDIN_REREAD = ("rg: error reading -f/--file from stdin: "
                   "stdin has already been consumed\n")
RG_STDIN_SEARCHED = ("rg: error: attempted to read patterns from stdin "
                     "while also searching stdin\n")


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
) -> tuple[list[str], dict[str, FlagValue], ByteSource | None, IOResult
           | None]:
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
            if name != "jq" and is_stdin(path):
                if name == "rg" and path.raw_path == "-":
                    if taken:
                        return texts, flags, stdin, IOResult(
                            exit_code=2, stderr=RG_STDIN_REREAD.encode())
                    taken = True
                pieces.append(await materialize(source))
                consumed = True
            else:
                data, _ = await dispatch("read", path)
                pieces.append(await materialize(data))
        except FS_ERRORS as exc:
            # Match GNU's fatal script-open status; ordinary input-file
            # failures still belong to the native command handlers.
            line = fs_error_line(name, path, exc)
            if name == "sed":
                line = line.replace("sed: ", "sed: couldn't open file ", 1)
            return texts, flags, stdin, IOResult(
                exit_code=4 if name == "sed" else 2, stderr=line.encode())
    if taken and any(p.raw_path == "-" for p in operands):
        return texts, flags, stdin, IOResult(exit_code=2,
                                             stderr=RG_STDIN_SEARCHED.encode())
    out = dict(flags)
    out.pop(key)
    if name in ("grep", "rg"):
        inline = fl.as_list(PATTERN_KEYS[name])
        pattern = "\n".join(inline) if inline else None
        for data in pieces:
            pattern = merge_pattern_list(pattern, data)
        # An empty pattern-file list preserves grep's zero-pattern sentinel.
        out[key] = []
        out[PATTERN_KEYS[name]] = [] if pattern is None else [pattern]
    elif name == "sed":
        out["e"] = [
            *fl.as_list("e"),
            *(data.decode(errors="replace").removesuffix("\n")
              for data in pieces)
        ]
    else:
        texts = [
            "\n".join(data.decode(errors="replace") for data in pieces), *texts
        ]
    return texts, out, source if consumed else stdin, None
