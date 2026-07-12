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

# Bash arithmetic tokens: integer literals (decimal/hex/octal), variable
# names, then operators longest-first so `<<=` never lexes as `<<` + `=`.
ARITH_TOKEN = re.compile(
    r"""
    (?P<num>0[xX][0-9a-fA-F]+|\d+)
  | (?P<name>[A-Za-z_]\w*)
  | (?P<op><<=|>>=|\*\*|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\|
       |\+=|-=|\*=|/=|%=|&=|\^=|\|=
       |[-+*/%<>=!~&|^?:(),])
  | (?P<ws>\s+)
  | (?P<bad>.)
""", re.VERBOSE)

ARITH_NAME = re.compile(r"[A-Za-z_]\w*")

ARITH_ASSIGN_OPS = frozenset(
    {"=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="})

# 64-bit wrap like bash (intmax_t arithmetic).
ARITH_WRAP = 1 << 64
ARITH_SIGN = 1 << 63

# Recursion budget for variables holding expressions (`x="1+2"; $((x))`),
# mirroring bash's expression recursion limit.
ARITH_MAX_DEPTH = 16
