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
    "mkdir": CommandSpec(
        arguments=(
            Argument("-p", "--parents", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("-m", "--mode"),
            # GNU: -Z never takes an argument; only --context= carries
            # one, so the short stays clusterable (-vZ) and `-Zfoo` is
            # refused.
            Argument(
                "-Z",
                "--context",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "touch": CommandSpec(
        arguments=(
            Argument("-a", action="store_true"),
            Argument("-c", "--no-create", action="store_true"),
            Argument("-d", "--date"),
            Argument("-f", action="store_true"),
            Argument("-h", "--no-dereference", action="store_true"),
            Argument("-m", action="store_true"),
            Argument("-r", "--reference", type="path"),
            Argument("-t"),
            Argument("--time"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    # The leading MODE/OWNER/GROUP stays TEXT while the FILE operands
    # classify as PATH, so relative operands resolve against the session
    # cwd, not the mount root.
    "chmod": CommandSpec(
        arguments=(
            Argument("-c", "--changes", action="store_true"),
            Argument("-f", "--silent", action="store_true"),
            Argument("--quiet", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("-R", "--recursive", action="store_true"),
            Argument("text", nargs="?", metavar=""),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "chown": CommandSpec(
        arguments=(
            Argument("-c", "--changes", action="store_true"),
            Argument("-f", "--silent", action="store_true"),
            Argument("--quiet", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("--dereference", action="store_true"),
            Argument("-h", "--no-dereference", action="store_true"),
            Argument("-R", "--recursive", action="store_true"),
            Argument("text", nargs="?", metavar=""),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "chgrp": CommandSpec(
        arguments=(
            Argument("-c", "--changes", action="store_true"),
            Argument("-f", "--silent", action="store_true"),
            Argument("--quiet", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("--dereference", action="store_true"),
            Argument("-h", "--no-dereference", action="store_true"),
            Argument("-R", "--recursive", action="store_true"),
            Argument("text", nargs="?", metavar=""),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "cp": CommandSpec(
        arguments=(
            Argument("-r", action="store_true"),
            Argument("-R", "--recursive", action="store_true"),
            Argument("-a", "--archive", action="store_true"),
            # The link policy: the last of these and -a wins.
            Argument("-L", "--dereference", action="store_true"),
            Argument("-P", "--no-dereference", action="store_true"),
            Argument("-H", action="store_true"),
            Argument("-d", action="store_true"),
            # Non-interactive control plane (rm precedent): -f/-i are
            # accepted no-ops — there is no prompt, and an overwrite
            # proceeds unless -n/--update say otherwise.
            Argument("-f", "--force", action="store_true"),
            Argument("-i", "--interactive", action="store_true"),
            Argument("-n", "--no-clobber", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            # GNU: -u/-b never take an argument; only --update=/--backup=
            # carry values, so the shorts stay clusterable (-bv).
            Argument(
                "-u",
                "--update",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument(
                "-b",
                "--backup",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            # PathSpec normalizes trailing slashes everywhere, so the GNU
            # spelling is an accepted no-op.
            Argument("--strip-trailing-slashes", action="store_true"),
            Argument("-t", "--target-directory", type="path"),
            Argument("-T", "--no-target-directory", action="store_true"),
            Argument("-S", "--suffix"),
            Argument("-x", "--one-file-system", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "mv": CommandSpec(
        arguments=(
            # Non-interactive control plane (rm precedent): -f/-i are
            # accepted no-ops — there is no prompt, and an overwrite
            # proceeds unless -n/--update say otherwise.
            Argument("-f", "--force", action="store_true"),
            Argument("-i", "--interactive", action="store_true"),
            Argument("-n", "--no-clobber", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            # GNU: -u/-b never take an argument; only --update=/--backup=
            # carry values, so the shorts stay clusterable (-bv).
            Argument(
                "-u",
                "--update",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument(
                "-b",
                "--backup",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            # PathSpec normalizes trailing slashes everywhere, so the GNU
            # spelling is an accepted no-op.
            Argument("--strip-trailing-slashes", action="store_true"),
            Argument("-t", "--target-directory", type="path"),
            # Cross-mount moves are copy+remove; --no-copy turns them into
            # GNU's cross-device refusal instead.
            Argument("--no-copy", action="store_true"),
            Argument("--exchange", action="store_true"),
            Argument("-T", "--no-target-directory", action="store_true"),
            Argument("-S", "--suffix"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "rm": CommandSpec(
        arguments=(
            Argument("-r", action="store_true"),
            Argument("-R", action="store_true"),
            Argument("-f", action="store_true"),
            Argument("-v", action="store_true"),
            Argument("-d", action="store_true"),
            # Non-interactive control plane: -i/-I are accepted no-ops
            # (there is no prompt; removal always proceeds).
            Argument("-i", action="store_true"),
            Argument("-I", action="store_true"),
            # Mount roots (and /) are structurally protected and never
            # removable, so the root failsafe is always on and cannot be
            # disabled; both spellings are accepted no-ops. Recursion never
            # crosses a mount boundary either, so --one-file-system already
            # matches mirage's default.
            Argument("--preserve-root", action="store_true"),
            Argument("--no-preserve-root", action="store_true"),
            Argument("--one-file-system", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "rmdir": CommandSpec(
        arguments=(
            Argument("--ignore-fail-on-non-empty", action="store_true"),
            Argument("-p", "--parents", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "unlink": CommandSpec(
        arguments=(Argument("paths", type="path", nargs="*", metavar=""),)
    ),
    "truncate": CommandSpec(
        arguments=(
            Argument("-c", "--no-create", action="store_true"),
            Argument("-s", "--size"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "basename": CommandSpec(
        arguments=(
            Argument("-a", "--multiple", action="store_true"),
            Argument("-s", "--suffix"),
            Argument("-z", "--zero", action="store_true"),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
    "dirname": CommandSpec(
        arguments=(
            Argument("-z", "--zero", action="store_true"),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
    "realpath": CommandSpec(
        arguments=(
            Argument("-e", "--canonicalize-existing", action="store_true"),
            Argument("-m", "--canonicalize-missing", action="store_true"),
            Argument("-L", "--logical", action="store_true"),
            Argument("-P", "--physical", action="store_true"),
            Argument("-q", "--quiet", action="store_true"),
            Argument("--relative-to"),
            Argument("--relative-base"),
            Argument("-s", "--strip", action="store_true"),
            Argument("--no-symlinks", action="store_true"),
            Argument("-z", "--zero", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "readlink": CommandSpec(
        arguments=(
            Argument("-f", "--canonicalize", action="store_true"),
            Argument("-e", "--canonicalize-existing", action="store_true"),
            Argument("-m", "--canonicalize-missing", action="store_true"),
            Argument("-n", "--no-newline", action="store_true"),
            Argument("-q", "--quiet", action="store_true"),
            Argument("-s", "--silent", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("-z", "--zero", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    # getfattr and setfattr run in the executor over the dispatcher's
    # attribute ops, like readlink and ln, so these specs are their
    # grammar and no builder binds them. Pinned against Debian's attr
    # 2.5.2; --one-file-system, --restore and --raw are not offered.
    "getfattr": CommandSpec(
        arguments=(
            Argument(
                "-n",
                "--name",
                help="get the named extended attribute value",
            ),
            Argument(
                "-d",
                "--dump",
                action="store_true",
                help="get all extended attribute values",
            ),
            Argument(
                "-e",
                "--encoding",
                help="encode values (as 'text', 'hex' or 'base64')",
            ),
            Argument(
                "-m",
                "--match",
                help="only get attributes with names matching pattern",
            ),
            Argument(
                "--only-values",
                action="store_true",
                help="print the bare values only",
            ),
            Argument(
                "-h",
                "--no-dereference",
                action="store_true",
                help="do not dereference symbolic links",
            ),
            Argument(
                "--absolute-names",
                action="store_true",
                help="don't strip leading '/' in pathnames",
            ),
            Argument(
                "-R",
                "--recursive",
                action="store_true",
                help="recurse into subdirectories",
            ),
            Argument(
                "-L",
                "--logical",
                action="store_true",
                help="logical walk, follow symbolic links",
            ),
            Argument(
                "-P",
                "--physical",
                action="store_true",
                help="physical walk, do not follow symbolic links",
            ),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    "setfattr": CommandSpec(
        arguments=(
            Argument(
                "-n",
                "--name",
                help="set the value of the named extended attribute",
            ),
            Argument(
                "-x",
                "--remove",
                help="remove the named extended attribute",
            ),
            Argument(
                "-v",
                "--value",
                help="use value as the attribute value",
            ),
            Argument(
                "-h",
                "--no-dereference",
                action="store_true",
                help="do not dereference symbolic links",
            ),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
    # ln runs in the executor for both link kinds (a symlink is namespace
    # state, a "hard link" is a byte copy through the dispatcher), so this
    # spec is its grammar authority and no builder binds it.
    "ln": CommandSpec(
        arguments=(
            Argument("-S", "--suffix"),
            Argument("-f", "--force", action="store_true"),
            Argument("-n", "--no-dereference", action="store_true"),
            Argument("-v", "--verbose", action="store_true"),
            Argument("-r", "--relative", action="store_true"),
            Argument("-L", "--logical", action="store_true"),
            Argument("-P", "--physical", action="store_true"),
            Argument("-d", "--directory", action="store_true"),
            Argument("-F", action="store_true"),
            # GNU: -b never takes an argument; only --backup= carries a
            # value, so the short stays clusterable (-sbv).
            Argument(
                "-b",
                "--backup",
                nargs="?",
                attached_only=True,
                short_value=False,
            ),
            Argument("-s", "--symbolic", action="store_true"),
            Argument("-t", "--target-directory", type="path"),
            Argument("-T", "--no-target-directory", action="store_true"),
            Argument("paths", type="path", nargs="*", metavar=""),
        )
    ),
}
