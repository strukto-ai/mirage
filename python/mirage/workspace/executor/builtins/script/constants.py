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

from mirage.commands.spec import SPECS

# GNU prints the refusal and the usage line together, both under the
# builtin's own name as typed (`source` or `.`), and exits 2 without
# ending the script.
SOURCE_USAGE = (
    "filename argument required\n{name}: usage: {name} filename [arguments]"
)

# Startup letters bash has that `set` does not. `c` takes the program
# text from the next word and `s` reads it from stdin; the rest have
# nothing to configure in an embedded shell, which has no login profile,
# no rc file and no tty. Letters that name a `set` option (-e -u -x -f)
# are not here: parse_option_word already knows them, so the two
# spellings cannot drift.
BASH_START_FLAGS = frozenset({"c", "s", "l", "i"})

# These GNU Bash modes are recognized but not implemented. Help/version
# outrank them; unknown options still fail during the long-option pass.
BASH_UNSUPPORTED_LONG_OPTIONS = frozenset(
    {
        "debugger",
        "dump-po-strings",
        "dump-strings",
        "pretty-print",
        "restricted",
    }
)

# True means the next word is a value. Derive supported options from the
# spec so the parser and help cannot drift; Bash accepts one or two dashes.
BASH_LONG_OPTIONS: dict[str, bool] = {
    **{
        option.long[2:]: option.type == "str"
        for option in SPECS["bash"].options
        if option.long
    },
    **dict.fromkeys(
        (*BASH_UNSUPPORTED_LONG_OPTIONS, "help", "version"), False
    ),
}
