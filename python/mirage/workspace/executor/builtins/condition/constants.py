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

import operator
from collections.abc import Callable, Mapping

INT_COMPARATORS: Mapping[str, Callable[[int, int], bool]] = {
    "-eq": operator.eq,
    "-ne": operator.ne,
    "-lt": operator.lt,
    "-le": operator.le,
    "-gt": operator.gt,
    "-ge": operator.ge,
}

STRING_BINARY = frozenset({"=", "==", "!="})
NUMERIC_BINARY = frozenset(INT_COMPARATORS)
# `-nt`/`-ot` compare modification times; `-ef` asks for the same file,
# which mirage answers as the same resolved path (a mount has no device
# or inode to compare, and one path names one entry).
FILE_PAIR_BINARY = frozenset({"-nt", "-ot", "-ef"})
STRING_UNARY = frozenset({"-n", "-z"})
# `-v NAME` asks whether the variable (or the `NAME[sub]` element) is
# set; it reads session state, not a path.
VAR_UNARY = frozenset({"-v"})
FILE_UNARY = frozenset(
    {"-e", "-f", "-d", "-c", "-s", "-r", "-w", "-x", "-L", "-h"})
# Real GNU operators mirage cannot answer truthfully: the VFS has no
# FIFO/socket/block-device node types, no uid/gid ownership or setuid
# bits, and no controlling terminal. (Character devices ARE modelled, so
# -c is supported above.) Failing loudly beats the silent-false this
# module used to produce.
UNSUPPORTED_UNARY = frozenset(
    {"-p", "-S", "-b", "-g", "-k", "-u", "-O", "-G", "-N", "-t"})
BINARY_OPS = STRING_BINARY | NUMERIC_BINARY | FILE_PAIR_BINARY
UNARY_OPS = STRING_UNARY | VAR_UNARY | FILE_UNARY | UNSUPPORTED_UNARY
