# Every diagnostic below is GNU tar 1.35's own wording, pinned on
# debian:stable-slim. argp's refusals of the options and the archive's own
# diagnostics are mirage-rs's.
USAGE_HINT = "Try 'tar --help' or 'tar --usage' for more information."
EMPTY_ARCHIVE = "tar: Cowardly refusing to create an empty archive"
# GNU normalizes an empty operand to `.` before it stats it, says so, and
# then still names the operand as typed when the stat fails (tar 1.35).
EMPTY_MEMBER = "tar: Substituting `.' for empty member name"
FATAL_TRAILER = "tar: Error is not recoverable: exiting now"
SELF_DUMP = "archive cannot contain itself; not dumped"
# The exit GNU gives an operand it could not read, and a -C it could not
# enter. Both are fatal for the whole run, not per-operand.
CREATE_ERROR_EXIT = 2
# What --exclude-vcs leaves out, as the manual lists it.
VCS_NAMES = (
    "CVS",
    "RCS",
    "SCCS",
    ".git",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".svn",
    ".cvsignore",
    ".arch-ids",
    "{arch}",
    "=RELEASE-ID",
    "=meta-update",
    "=update",
    ".bzr",
    ".bzrignore",
    ".bzrtags",
    ".hg",
    ".hgignore",
    ".hgtags",
    "_darcs",
)
# The compressor -a picks by the archive's suffix.
SUFFIX_CODECS = {
    ".gz": "gzip",
    ".tgz": "gzip",
    ".taz": "gzip",
    ".bz2": "bzip2",
    ".tz2": "bzip2",
    ".tbz2": "bzip2",
    ".tbz": "bzip2",
    ".xz": "xz",
    ".txz": "xz",
    ".lzma": "xz",
    ".tlz": "xz",
}
# The suffixes -a answers with a compressor mirage does not have.
SUFFIX_UNAVAILABLE = {
    ".Z": "compress",
    ".taZ": "compress",
    ".lz": "lzip",
    ".lzo": "lzop",
}
