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

from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)

SPECS: dict[str, CommandSpec] = {
    'mkdir':
    CommandSpec(
        options=(
            Option(short="-p", long="--parents"),
            Option(short="-v", long="--verbose"),
            Option(short="-m", long="--mode", value_kind=OperandKind.TEXT),
            Option(short="-Z",
                   long="--context",
                   value_kind=OperandKind.TEXT,
                   value_optional=True),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'touch':
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-r", value_kind=OperandKind.PATH),
            Option(short="-d", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    # chmod/chown/chgrp self-parse their flags in the executor builtins, but
    # they still need a spec so the leading MODE/OWNER/GROUP stays TEXT while
    # the FILE operands classify as PATH (and so relative operands resolve
    # against the session cwd, not the mount root).
    'chmod':
    CommandSpec(
        options=(Option(short="-R"), Option(short="-v"), Option(short="-f")),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'chown':
    CommandSpec(
        options=(Option(short="-R"), Option(short="-v"), Option(short="-f"),
                 Option(short="-h")),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'chgrp':
    CommandSpec(
        options=(Option(short="-R"), Option(short="-v"), Option(short="-f"),
                 Option(short="-h")),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'cp':
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-a"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'mv':
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
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
        rest=Operand(kind=OperandKind.PATH),
    ),
    'rmdir':
    CommandSpec(
        options=(Option(short="-v"), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'unlink':
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    'truncate':
    CommandSpec(
        options=(Option(short="-s", long="--size",
                        value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'basename':
    CommandSpec(
        options=(
            Option(short="-a", long="--multiple"),
            Option(short="-s", long="--suffix", value_kind=OperandKind.TEXT),
            Option(short="-z", long="--zero"),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'dirname':
    CommandSpec(
        options=(Option(short="-z", long="--zero"), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    'realpath':
    CommandSpec(
        options=(
            Option(short="-e"),
            Option(short="-m"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'readlink':
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-e"),
            Option(short="-m"),
            Option(short="-n"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    'ln':
    CommandSpec(
        options=(
            Option(short="-s"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
