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

from mirage.commands.spec.types import Argument, CommandSpec

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
            Argument("-z", "--gzip", action="store_true"),
            Argument("-j", "--bzip2", action="store_true"),
            Argument("-J", "--xz", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            # -h archives what a symlink points at instead of the link.
            Argument("-h", "--dereference", action="store_true"),
            Argument("-O", "--to-stdout", action="store_true"),
            Argument("-f", "--file", type="path"),
            # Every occurrence is kept, in order: GNU chdirs at each
            # one and fails at the first it cannot enter, so the
            # planner has to see them all, not just the last.
            Argument("-C", "--directory", type="path", action="append"),
            Argument("--strip-components"),
            Argument("--exclude"),
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
                text_when=("-x", "-t"),
            ),
        ),
    ),
    "gzip": CommandSpec(
        arguments=(
            Argument("-d", action="store_true"),
            Argument("-k", action="store_true"),
            Argument("-f", action="store_true"),
            Argument("-c", action="store_true"),
            Argument("-q", action="store_true"),
            Argument("-S"),
            Argument("-1", action="store_true"),
            Argument("-2", action="store_true"),
            Argument("-3", action="store_true"),
            Argument("-4", action="store_true"),
            Argument("-5", action="store_true"),
            Argument("-6", action="store_true"),
            Argument("-7", action="store_true"),
            Argument("-8", action="store_true"),
            Argument("-9", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "gunzip": CommandSpec(
        arguments=(
            Argument("-k", action="store_true"),
            Argument("-f", action="store_true"),
            Argument("-c", action="store_true"),
            Argument("-t", action="store_true"),
            Argument("-q", action="store_true"),
            Argument("-S"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
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
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "unzip": CommandSpec(
        arguments=(
            Argument("-o", action="store_true"),
            Argument("-n", action="store_true"),
            Argument("-l", action="store_true"),
            Argument("-d", type="path"),
            Argument("-q", action="store_true"),
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
            # The archive is the only path operand; everything after it is an
            # Info-ZIP member pattern matched against archive entry names,
            # never a filesystem path.
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
    # zcat is `gzip -cd`: -f copies input that is not gzip, -q drops
    # the warnings, and -S names the suffix a missing name is retried with.
    "zcat": CommandSpec(
        arguments=(
            Argument("-f", action="store_true"),
            Argument("-q", action="store_true"),
            Argument("-S"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
}
