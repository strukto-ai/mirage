from mirage.commands.builtin.generic.tar.types import (CompressionSuffix,
                                                       ReadMode, WriteMode)

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
FATAL_TRAILER = "tar: Error is not recoverable: exiting now"
# What tar adds when its gzip -d child fails, after gzip's own lines.
CHILD_STATUS = "tar: Child returned status {}"
INVALID_ARCHIVE = ("tar: This does not look like a tar archive",
                   "tar: Skipping to next header")
ERROR_TRAILER = "tar: Exiting with failure status due to previous errors"
SELF_DUMP = "archive cannot contain itself; not dumped"
# The exit GNU gives an operand it could not read, and a -C it could not
# enter. Both are fatal for the whole run, not per-operand.
CREATE_ERROR_EXIT = 2
