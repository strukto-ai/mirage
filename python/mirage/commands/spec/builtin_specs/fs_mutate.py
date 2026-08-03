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

from mirage.commands.spec.types import CommandSpec, Operand, Option

SPECS: dict[str, CommandSpec] = {
    'mkdir':
    CommandSpec(
        options=(
            Option(short="-p", long="--parents"),
            Option(short="-v", long="--verbose"),
            Option(short="-m", long="--mode", type="str"),
            Option(short="-Z",
                   long="--context",
                   type="str",
                   value_optional=True),
        ),
        rest=Operand(type="path"),
    ),
    'touch':
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-r", type="path"),
            Option(short="-d", type="str"),
        ),
        rest=Operand(type="path"),
    ),
    # chmod/chown/chgrp self-parse their flags in the executor builtins, but
    # they still need a spec so the leading MODE/OWNER/GROUP stays TEXT while
    # the FILE operands classify as PATH (and so relative operands resolve
    # against the session cwd, not the mount root).
    'chmod':
    CommandSpec(
        options=(Option(short="-R"), Option(short="-v"), Option(short="-f")),
        positional=(Operand(type="str"), ),
        rest=Operand(type="path"),
    ),
    'chown':
    CommandSpec(
        options=(Option(short="-R"), Option(short="-v"), Option(short="-f"),
                 Option(short="-h")),
        positional=(Operand(type="str"), ),
        rest=Operand(type="path"),
    ),
    'chgrp':
    CommandSpec(
        options=(Option(short="-R"), Option(short="-v"), Option(short="-f"),
                 Option(short="-h")),
        positional=(Operand(type="str"), ),
        rest=Operand(type="path"),
    ),
    'cp':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R", long="--recursive"),
            Option(short="-a", long="--archive"),
            # Non-interactive control plane (rm precedent): -f/-i are
            # accepted no-ops — there is no prompt, and an overwrite
            # proceeds unless -n/--update say otherwise.
            Option(short="-f", long="--force"),
            Option(short="-i", long="--interactive"),
            Option(short="-n", long="--no-clobber"),
            Option(short="-v", long="--verbose"),
            # GNU: -u/-b never take an argument; only --update=/--backup=
            # carry values, so the shorts stay clusterable (-bv).
            Option(short="-u",
                   long="--update",
                   type="str",
                   value_optional=True,
                   short_value=False),
            Option(short="-b",
                   long="--backup",
                   type="str",
                   value_optional=True,
                   short_value=False),
            Option(short="-S", long="--suffix", type="str"),
            Option(short="-t", long="--target-directory", type="path"),
            Option(short="-T", long="--no-target-directory"),
            # PathSpec normalizes trailing slashes everywhere, so the GNU
            # spelling is an accepted no-op.
            Option(long="--strip-trailing-slashes"),
        ),
        rest=Operand(type="path"),
    ),
    'mv':
    CommandSpec(
        options=(
            # Non-interactive control plane (rm precedent): -f/-i are
            # accepted no-ops — there is no prompt, and an overwrite
            # proceeds unless -n/--update say otherwise.
            Option(short="-f", long="--force"),
            Option(short="-i", long="--interactive"),
            Option(short="-n", long="--no-clobber"),
            Option(short="-v", long="--verbose"),
            # GNU: -u/-b never take an argument; only --update=/--backup=
            # carry values, so the shorts stay clusterable (-bv).
            Option(short="-u",
                   long="--update",
                   type="str",
                   value_optional=True,
                   short_value=False),
            Option(short="-b",
                   long="--backup",
                   type="str",
                   value_optional=True,
                   short_value=False),
            Option(short="-S", long="--suffix", type="str"),
            Option(short="-t", long="--target-directory", type="path"),
            Option(short="-T", long="--no-target-directory"),
            Option(long="--exchange"),
            # Cross-mount moves are copy+remove; --no-copy turns them into
            # GNU's cross-device refusal instead.
            Option(long="--no-copy"),
            # PathSpec normalizes trailing slashes everywhere, so the GNU
            # spelling is an accepted no-op.
            Option(long="--strip-trailing-slashes"),
        ),
        rest=Operand(type="path"),
    ),
    'rm':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-f"),
            Option(short="-v"),
            Option(short="-d"),
            # Non-interactive control plane: -i/-I are accepted no-ops
            # (there is no prompt; removal always proceeds).
            Option(short="-i"),
            Option(short="-I"),
            # Mount roots (and /) are structurally protected and never
            # removable, so the root failsafe is always on and cannot be
            # disabled; both spellings are accepted no-ops. Recursion never
            # crosses a mount boundary either, so --one-file-system already
            # matches mirage's default.
            Option(long="--preserve-root"),
            Option(long="--no-preserve-root"),
            Option(long="--one-file-system"),
        ),
        rest=Operand(type="path"),
    ),
    'rmdir':
    CommandSpec(
        options=(Option(short="-v"), ),
        rest=Operand(type="path"),
    ),
    'unlink':
    CommandSpec(rest=Operand(type="path")),
    'truncate':
    CommandSpec(
        options=(Option(short="-s", long="--size", type="str"), ),
        rest=Operand(type="path"),
    ),
    'basename':
    CommandSpec(
        options=(
            Option(short="-a", long="--multiple"),
            Option(short="-s", long="--suffix", type="str"),
            Option(short="-z", long="--zero"),
        ),
        rest=Operand(type="str"),
    ),
    'dirname':
    CommandSpec(
        options=(Option(short="-z", long="--zero"), ),
        rest=Operand(type="str"),
    ),
    'realpath':
    CommandSpec(
        options=(
            Option(short="-e"),
            Option(short="-m"),
        ),
        rest=Operand(type="path"),
    ),
    'readlink':
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-e"),
            Option(short="-m"),
            Option(short="-n"),
        ),
        rest=Operand(type="path"),
    ),
    'ln':
    CommandSpec(
        options=(
            Option(short="-s"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(type="path"),
    ),
}
