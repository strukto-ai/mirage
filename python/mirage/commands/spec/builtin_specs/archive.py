# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.commands.spec.constants import (
    PATH_OPERAND,
    PATHS_OPERAND,
    TEXTS_OPERAND,
)
from mirage.commands.spec.types import Argument, CommandSpec

# gunzip is `gzip -d` and zcat `gzip -cd`, and each takes all of gzip's
# options: -l lists, -t tests, -N restores and -n drops the stored name
# and time, -r walks directories, and the digits are no-ops past gzip.
_GZIP_ARGUMENTS = (
    Argument("-c", "--stdout", "--to-stdout", action="store_true"),
    Argument("-d", "--decompress", "--uncompress", action="store_true"),
    Argument("-f", "--force", action="store_true"),
    Argument("-k", "--keep", action="store_true"),
    Argument("-l", "--list", action="store_true"),
    Argument("-n", "--no-name", action="store_true"),
    Argument("-N", "--name", action="store_true"),
    Argument("-q", "--quiet", action="store_true"),
    Argument("-r", "--recursive", action="store_true"),
    Argument("-S", "--suffix"),
    Argument("-t", "--test", action="store_true"),
    Argument("-v", "--verbose", action="store_true"),
    Argument("--rsyncable", action="store_true"),
    Argument("--synchronous", action="store_true"),
    Argument("-1", "--fast", action="store_true"),
    *(Argument(f"-{n}", action="store_true") for n in range(2, 9)),
    Argument("-9", "--best", action="store_true"),
    PATHS_OPERAND,
)

_XZ_ARGUMENTS = (
    Argument("-z", "--compress", action="store_true"),
    Argument("-d", "--decompress", "--uncompress", action="store_true"),
    Argument("-t", "--test", action="store_true"),
    Argument("-k", "--keep", action="store_true"),
    Argument("-f", "--force", action="store_true"),
    Argument("-c", "--stdout", "--to-stdout", action="store_true"),
    Argument("-q", "--quiet", action="count"),
    Argument("-v", "--verbose", action="count"),
    Argument("-e", "--extreme", action="store_true"),
    Argument("-0", "--fast", action="store_true"),
    *(Argument(f"-{n}", action="store_true") for n in range(1, 9)),
    Argument("-9", "--best", action="store_true"),
    Argument("-T", "--threads"),
    Argument("-C", "--check"),
    Argument("-F", "--format"),
    Argument("-S", "--suffix"),
    PATHS_OPERAND,
)

_BZIP2_ARGUMENTS = (
    Argument("-z", "--compress", action="store_true"),
    Argument("-d", "--decompress", action="store_true"),
    Argument("-t", "--test", action="store_true"),
    Argument("-k", "--keep", action="store_true"),
    Argument("-f", "--force", action="store_true"),
    Argument("-c", "--stdout", action="store_true"),
    Argument("-q", "--quiet", action="store_true"),
    Argument("-v", "--verbose", action="count"),
    Argument("-s", "--small", action="store_true"),
    Argument("-1", "--fast", action="store_true"),
    *(Argument(f"-{n}", action="store_true") for n in range(2, 9)),
    Argument("-9", "--best", action="store_true"),
    Argument("--repetitive-fast", action="store_true"),
    Argument("--repetitive-best", action="store_true"),
    Argument("--exponential", action="store_true"),
    PATHS_OPERAND,
)

SPECS: dict[str, CommandSpec] = {
    "tar": CommandSpec(
        # `tar xzf a.tgz` is the spelling everyone types.
        old_option_style=True,
        # -C is a chdir for the operands after it, not a flag the command
        # reads once: `tar -cf a.tar -C d x` archives d/x as `x`.
        operand_base="-C",
        arguments=(
            # Each option under GNU tar's own long name. Its aliases (--get,
            # --gunzip, --ungzip) and every abbreviation resolve through
            # LONG_OPTION_TABLES, tar's whole table, which also knows the
            # options mirage does not declare.
            Argument("-c", "--create", action="store_true"),
            Argument("-x", "--extract", action="store_true"),
            Argument("-t", "--list", action="store_true"),
            Argument("-r", "--append", action="store_true"),
            Argument("-u", "--update", action="store_true"),
            Argument("--delete", action="store_true"),
            Argument("-z", "--gzip", action="store_true"),
            Argument("-j", "--bzip2", action="store_true"),
            Argument("-J", "--xz", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            # -h archives what a symlink points at instead of the link.
            Argument("-h", "--dereference", action="store_true"),
            Argument("-O", "--to-stdout", action="store_true"),
            Argument("-a", "--auto-compress", action="store_true"),
            Argument("-k", "--keep-old-files", action="store_true"),
            Argument("--overwrite", action="store_true"),
            Argument("--skip-old-files", action="store_true"),
            Argument("-p", "--preserve-permissions", action="store_true"),
            Argument("-P", "--absolute-names", action="store_true"),
            # Extraction stamps no time of its own, so -m has nothing to
            # turn off.
            Argument("-m", "--touch", action="store_true"),
            Argument("--numeric-owner", action="store_true"),
            Argument("--owner"),
            Argument("--group"),
            Argument("--mtime"),
            Argument("--sort"),
            Argument("--transform", action="append"),
            Argument("-T", "--files-from", type="path", action="append"),
            Argument("--null", action="store_true"),
            Argument("-X", "--exclude-from", type="path", action="append"),
            Argument("--exclude-vcs", action="store_true"),
            # Each applies to the patterns typed after it.
            Argument("--wildcards", action="store_true"),
            Argument("--no-wildcards", action="store_true"),
            Argument("--anchored", action="store_true"),
            Argument("--no-anchored", action="store_true"),
            Argument("-f", "--file", type="path"),
            # Every occurrence is kept, in order: GNU chdirs at each
            # one and fails at the first it cannot enter, so the
            # planner has to see them all, not just the last.
            Argument("-C", "--directory", type="path", action="append"),
            Argument("--strip-components"),
            Argument("--exclude", action="append"),
            Argument("--one-file-system", action="store_true"),
            # Only -c reads the rest operands from the filesystem. Under -t
            # and -x each one is a member selector matched against names
            # inside the archive (the same mode split MountRootPolicy keys
            # on), so those lines keep them textual, exactly as unzip's
            # member patterns are.
            Argument(
                "paths",
                type="path",
                nargs="*",
                metavar="",
                text_when=("-x", "-t", "--delete"),
            ),
        ),
    ),
    "gzip": CommandSpec(arguments=_GZIP_ARGUMENTS),
    "gunzip": CommandSpec(arguments=_GZIP_ARGUMENTS),
    "zip": CommandSpec(
        arguments=(
            Argument("-r", action="store_true"),
            Argument("-j", action="store_true"),
            Argument("-q", action="store_true"),
            Argument("-X", "--no-extra", action="store_true"),
            # -y stores a symlink as a symlink; without it zip archives
            # what the link points at, which is tar's -h inverted.
            Argument("-y", action="store_true"),
            # Info-ZIP reads -x as a variadic list of patterns; mirage
            # takes one per occurrence, since its spec has no variadic
            # option value and `-x a -x b` says the same thing.
            Argument("-x", action="append"),
            # -i is -x's counterpart, one pattern per occurrence as -x is.
            Argument("-i", action="append"),
            Argument("-u", action="store_true"),
            Argument("-f", action="store_true"),
            Argument("-d", action="store_true"),
            Argument("-m", action="store_true"),
            Argument("-T", action="store_true"),
            Argument("-v", action="store_true"),
            # -l turns line ends to CRLF and -ll back to LF.
            Argument("-l", action="count"),
            Argument("-D", action="store_true"),
            Argument("-b", type="path"),
            Argument("-c", action="store_true"),
            Argument("-z", action="store_true"),
            Argument("-@", action="store_true"),
            *(Argument(f"-{n}", action="store_true") for n in range(10)),
            PATHS_OPERAND,
        )
    ),
    "unzip": CommandSpec(
        arguments=(
            Argument("-o", action="store_true"),
            Argument("-n", action="store_true"),
            Argument("-l", action="store_true"),
            Argument("-d", type="path"),
            # -qq says less than -q.
            Argument("-q", action="count"),
            Argument("-p", action="store_true"),
            Argument("-t", action="store_true"),
            # -v is -l's verbose table, or the version banner when no
            # archive is named. zipinfo's own -v (a per-entry technical
            # dump) is not rendered: under -Z the letter is ignored.
            Argument("-v", action="store_true"),
            # Info-ZIP reads -x as a variadic list of patterns; mirage
            # takes one per occurrence, since its spec has no variadic
            # option value and `-x a -x b` says the same thing (zip's -x
            # has the same shape).
            Argument("-x", action="append"),
            # -Z is ZipInfo mode: the archive is listed from its central
            # directory instead of extracted, and the other letters are
            # read as zipinfo's (-1/-2 names only, -s short, -m medium and
            # -l long rows, -h header, -t totals). Info-ZIP demands -Z
            # first; the flag bag has no order, so mirage takes it
            # anywhere in the cluster.
            Argument("-Z", action="store_true"),
            Argument("-1", action="store_true"),
            Argument("-2", action="store_true"),
            Argument("-s", action="store_true"),
            Argument("-m", action="store_true"),
            Argument("-h", action="store_true"),
            Argument("-j", action="store_true"),
            Argument("-u", action="store_true"),
            Argument("-f", action="store_true"),
            Argument("-z", action="store_true"),
            Argument("-C", action="store_true"),
            Argument("-a", action="count"),
            Argument("-L", action="count"),
            # Owners and UTF-8 names are not mirage's to restore or spell
            # another way, so -X and -U change nothing.
            Argument("-X", action="store_true"),
            Argument("-U", action="count"),
            # The archive is the only path operand; everything after it is an
            # Info-ZIP member pattern matched against archive entry names,
            # never a filesystem path.
            PATH_OPERAND,
            TEXTS_OPERAND,
        )
    ),
    "zcat": CommandSpec(arguments=_GZIP_ARGUMENTS),
    "xz": CommandSpec(
        description="Compress or decompress .xz files.",
        arguments=_XZ_ARGUMENTS,
    ),
    "unxz": CommandSpec(
        description="Decompress .xz files.", arguments=_XZ_ARGUMENTS
    ),
    "bzip2": CommandSpec(
        description="Compress or decompress .bz2 files.",
        arguments=_BZIP2_ARGUMENTS,
        allow_abbrev=False,
    ),
    "bunzip2": CommandSpec(
        description="Decompress .bz2 files.",
        arguments=_BZIP2_ARGUMENTS,
        allow_abbrev=False,
    ),
}
