from mirage.commands.builtin.generic.tar.types import (
    CompressionSuffix,
    ReadMode,
    WriteMode,
)

WRITE_MODES: dict[CompressionSuffix, WriteMode] = {
    "": "w",
    ":gz": "w:gz",
    ":bz2": "w:bz2",
    ":xz": "w:xz",
}
READ_MODES: dict[CompressionSuffix, ReadMode] = {
    "": "r",
    ":gz": "r:gz",
    ":bz2": "r:bz2",
    ":xz": "r:xz",
}

# Every diagnostic below is GNU tar 1.35's own wording, pinned on
# debian:stable-slim; only the hint line is mirage's, for the reason
# usage.old_option_error gives (mirage's tar serves no --usage).
USAGE_HINT = "Try 'tar --help' for more information."
EMPTY_ARCHIVE = "tar: Cowardly refusing to create an empty archive"
# argp's mode refusals: a second main operation where the first one is
# already set, and a line that never names one. The double space is
# GNU's.
MODE_CONFLICT = (
    "tar: You may not specify more than one '-Acdtrux', "
    "'--delete' or  '--test-label' option"
)
NO_MODE = (
    "tar: You must specify one of the '-Acdtrux', '--delete' or "
    "'--test-label' options"
)
MULTIPLE_ARCHIVES = "tar: Multiple archive files require '-M' option"
# A --strip-components value that is no count, named first.
STRIP_COUNT = "tar: {}: Invalid number of elements"
# GNU normalizes an empty operand to `.` before it stats it, says so, and
# then still names the operand as typed when the stat fails (tar 1.35).
EMPTY_MEMBER = "tar: Substituting `.' for empty member name"
FATAL_TRAILER = "tar: Error is not recoverable: exiting now"
# What GNU adds when the archive opened but its first read failed (a
# directory given to -f).
TAPE_START = "tar: At beginning of tape, quitting now"
# What tar adds when its gzip -d child fails, after gzip's own lines.
CHILD_STATUS = "tar: Child returned status {}"
# With a compressor, the archive is opened by tar's child, which names
# itself so on every line it prints (tar 1.35).
CHILD_NAME = "tar (child)"
# What the compressor the child already spawned says when the child dies
# before feeding it, which happens for every open failure but a missing
# name (gzip 1.13, xz 5.4). bzip2's complaint is a paragraph of recovery
# advice that mirage does not reproduce.
EMPTY_PIPE = {
    ":gz": ("", "gzip: stdin: unexpected end of file"),
    ":xz": ("xz: (stdin): File format not recognized",),
}
# The child decompressor's refusal of an input that does not start with
# its magic, by compression: the magic, the line, the child's status, and
# whether an empty input is refused the same way (bzip2 1.0.8 answers an
# empty or cut input with a paragraph of recovery advice mirage does not
# reproduce; xz 5.8.1 refuses an empty one in these words).
FOREIGN_INPUT = {
    ":bz2": (b"BZh", "bzip2: (stdin) is not a bzip2 file.", 2, False),
    ":xz": (
        b"\xfd7zXZ\x00",
        "xz: (stdin): File format not recognized",
        1,
        True,
    ),
}
# What GNU says when a member's data runs past the end of the archive.
UNEXPECTED_EOF = "tar: Unexpected EOF in archive"
INVALID_ARCHIVE = (
    "tar: This does not look like a tar archive",
    "tar: Skipping to next header",
)
ERROR_TRAILER = "tar: Exiting with failure status due to previous errors"
SELF_DUMP = "archive cannot contain itself; not dumped"
# The exit GNU gives an operand it could not read, and a -C it could not
# enter. Both are fatal for the whole run, not per-operand.
CREATE_ERROR_EXIT = 2
