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

import re
from collections.abc import Mapping
from enum import Enum

from mirage.commands.builtin.types import RowActionKind
from mirage.commands.builtin.utils.size_suffix import size_suffixes


class PatternType(str, Enum):
    EXACT = "exact"
    SIMPLE = "simple"
    REGEX = "regex"


# Extensions a recursive grep skips without reading. Two families, and
# the second is load-bearing for any remote mount: the columnar formats
# were here first, and the model-weight formats joined them because a
# `grep -r` over a Hugging Face model repo otherwise downloads every
# checkpoint in it to search bytes that cannot contain a text match --
# 41 GB of transfer for one grep of openai/gpt-oss-20b. GNU has no such
# list (it sniffs the bytes it has already read off local disk), so this
# is a deliberate divergence that only costs a network fetch, and `-a`
# turns it off exactly as GNU's own binary handling does.
BINARY_EXTENSIONS = frozenset({
    ".parquet",
    ".orc",
    ".feather",
    ".arrow",
    ".ipc",
    ".hdf5",
    ".h5",
    ".safetensors",
    ".gguf",
    ".ggml",
    ".bin",
    ".pt",
    ".pth",
    ".ckpt",
    ".onnx",
    ".npy",
    ".npz",
    ".msgpack",
    ".tflite",
    ".pb",
    ".model",
})

FILE_MIME_MAP: dict[str, str] = {
    "text": "text/plain; charset=us-ascii",
    "json": "application/json; charset=us-ascii",
    "csv": "text/csv; charset=us-ascii",
    "directory": "inode/directory",
    "binary": "application/octet-stream",
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/gif": "image/gif",
    "application/zip": "application/zip",
    "application/gzip": "application/gzip",
    "application/pdf": "application/pdf",
}

# GNU `file -i` reports a symlink by its inode type, never by whatever
# the target would have sniffed as.
MIME_SYMLINK = "inode/symlink; charset=binary"

# od, split and cmp all read their counts with xstrtoumax, which skips leading
# whitespace and allows one '+' before the digits, so `-b +10` and `-b " 10"`
# are valid while `+ 10`, `++10`, `-10` and a trailing space are not.
# `[0-9]` not `\d`: GNU is ASCII-only, while python's `\d` would accept other
# Unicode decimal digits.
UINTMAX = 2**64 - 1
INTMAX = 2**63 - 1

OD_SIZE_UNITS = size_suffixes("bkKmMGTPE")
# Q/R/Y/Z are in GNU od's suffix set but always overflow uintmax, so they
# report as too-large rather than as unknown suffixes.
OD_OVERFLOW_UNITS = size_suffixes("QRYZ")
# strtoumax base 0: after the whitespace and sign above, 0x… is hex, a leading
# 0 is octal, else decimal; the unconsumed remainder is the suffix. The sign
# stays outside group 1 so the radix is picked from the digits alone
# (`-N +0x10` is hex, `-N +010` is octal).
XSTRTOUMAX_PATTERN = re.compile(
    r"^[ \t\n\v\f\r]*\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$")

# GNU cmp (diffutils 3.10) shares od's grammar above but not its letter set:
# no b/c/w, lowercase only up to k, and its gnulib predates Q/R, so `0Q`
# is an invalid value where `0Z` is a valid zero. Its ceiling is INTMAX, not
# UINTMAX, and an overflowing value reports as the same "invalid ... value"
# as a bad suffix rather than as too-large.
CMP_SIZE_UNITS = size_suffixes("kKMGTPEZY")

# GNU split's letter set: every uppercase power letter plus b, and lowercase
# k/m only (pinned against coreutils 9.7). Unlike od, split is base-10 only:
# hex and octal spellings are invalid numbers.
SPLIT_BYTE_UNITS = size_suffixes("bkKmMEGPQRTYZ")
SPLIT_BYTE_SUFFIXES = sorted(SPLIT_BYTE_UNITS, key=len, reverse=True)
SPLIT_COUNT_PATTERN = re.compile(r"[ \t\n\v\f\r]*\+?[0-9]+")
# Suffix start values are the exception to the grammar above: coreutils 9.7
# rejects both `--numeric-suffixes=+5` and `=" 5"`, so they keep the strict
# digits-only form.
SPLIT_DIGITS = re.compile(r"[0-9]+")
SPLIT_HEX_DIGITS = re.compile(r"[0-9a-fA-F]+")
SPLIT_TRY_HELP = "\nTry 'split --help' for more information."

# GNU answers a missing script with its whole thirty-nine line usage block
# and exit 1; mirage names the problem in one line instead, because the
# block is GNU's own prose and reproducing it buys a mirage user nothing.
# `no input files` and its exit 4 are GNU's exact spelling for `sed -i`
# with no operands, and mirage reuses them when there is no stdin either --
# it has no terminal for GNU's blocking read to reach. Both live here so
# the generic and its builder cannot drift apart again; there used to be
# four spellings across the two languages.
SED_MISSING_SCRIPT = "sed: missing script"
SED_NO_INPUT_FILES = "sed: no input files"
SED_NO_INPUT_EXIT = 4

# The word an `-exec` argument that stands for the match is spelled as.
EXEC_PLACEHOLDER = "{}"
# The two terminators of an `-exec` argument list: `;` ends a per-match
# run, `+` ends a batched run and only when it follows a bare `{}`.
EXEC_END = ";"
EXEC_BATCH_END = "+"

FIND_VALUE_PREDICATES = frozenset({
    "-name",
    "-iname",
    "-path",
    "-type",
    "-size",
    "-mtime",
    "-maxdepth",
    "-mindepth",
    "-printf",
    "-newer",
    "-newermt",
})

# `-exec` takes every word up to its terminator, so it is neither a
# value predicate nor a bare one.
FIND_EXEC_PREDICATES = frozenset({"-exec"})

FIND_BARE_PREDICATES = frozenset({
    "-empty",
    "-print",
    "-print0",
    "-delete",
    "-ls",
    "-depth",
})

FIND_OPERATORS = frozenset({
    "-not",
    "!",
    "-o",
    "-or",
    "-a",
    "-and",
    "(",
    ")",
})

FIND_EXPRESSION_TOKENS = (FIND_VALUE_PREDICATES | FIND_BARE_PREDICATES
                          | FIND_OPERATORS
                          | FIND_EXEC_PREDICATES)

FIND_VALID_TYPES = frozenset({"b", "c", "d", "p", "f", "l", "s"})

FIND_MAX_DEPTH = 100

FIND_ROW_ACTIONS: Mapping[str, RowActionKind] = {
    "-print": "print",
    "-print0": "print0",
    "-ls": "ls",
    "-delete": "delete",
}
