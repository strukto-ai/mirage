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

from collections.abc import Awaitable
from enum import Enum, StrEnum
from typing import Callable, NamedTuple

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec


class Strategy(Enum):
    """How a cross-mount command combines per-mount work.

    STREAM: ``cmd files...`` is equivalent to ``cat files... | cmd``, so
    each operand's raw bytes come from a native flagless ``cat`` on its
    owning mount and one native run of the real command consumes the
    merged stream.
    FANOUT: output is per-operand (filename-keyed lines or blocks), so the
    command runs natively once per operand on its owning mount and the
    outputs combine in operand order.
    RELAY: data from several mounts must colocate (copy targets, diff
    sides), so per-file primitives relay through the dispatcher and the
    shared generic does the work.
    """
    STREAM = "stream"
    FANOUT = "fanout"
    RELAY = "relay"


class Cmd(StrEnum):
    """Cross-mount capable command names.

    StrEnum members compare and hash as their plain string values, so
    ``cmd_name == Cmd.CP`` and ``cmd_name in RELAY_COMMANDS`` accept the
    raw ``str`` the executor passes.
    """
    CAT = "cat"
    NL = "nl"
    SORT = "sort"
    CUT = "cut"
    SED = "sed"
    REV = "rev"
    GREP = "grep"
    RG = "rg"
    HEAD = "head"
    TAIL = "tail"
    WC = "wc"
    DU = "du"
    FILE = "file"
    MD5 = "md5"
    MD5SUM = "md5sum"
    SHA1SUM = "sha1sum"
    SHA256SUM = "sha256sum"
    SHA384SUM = "sha384sum"
    SHA512SUM = "sha512sum"
    STAT = "stat"
    STRINGS = "strings"
    TAC = "tac"
    LS = "ls"
    FIND = "find"
    RM = "rm"
    RMDIR = "rmdir"
    UNLINK = "unlink"
    TOUCH = "touch"
    MKDIR = "mkdir"
    TEE = "tee"
    CP = "cp"
    MV = "mv"
    DIFF = "diff"
    CMP = "cmp"
    AWK = "awk"
    PASTE = "paste"
    COMM = "comm"
    JOIN = "join"


CrossResult = tuple[ByteSource | None, IOResult]

RunSingle = Callable[..., Awaitable[CrossResult]]


class OperandRun(NamedTuple):
    scope: PathSpec
    data: bytes
    io: IOResult
