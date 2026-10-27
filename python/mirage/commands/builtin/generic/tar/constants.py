# Every diagnostic below is GNU tar 1.35's own wording, pinned on
# debian:stable-slim; only the hint line is mirage's, for the reason
# usage.old_option_error gives (mirage's tar serves no --usage). The
# archive's own diagnostics are mirage-rs's.
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
SELF_DUMP = "archive cannot contain itself; not dumped"
# The exit GNU gives an operand it could not read, and a -C it could not
# enter. Both are fatal for the whole run, not per-operand.
CREATE_ERROR_EXIT = 2
