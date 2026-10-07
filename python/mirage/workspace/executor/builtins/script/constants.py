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
from mirage.shell.constants import SET_OPTION_NAMES
from mirage.workspace.executor.builtins.script.types import BashLongOption

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

# bash 5.2's long options (`long_args` in shell.c, the list `bash --help`
# prints), by name. bash reads them only before the first short option, a
# word at a time, with one dash or two: `bash -norc` is `bash --norc`. The
# ones the spec lists come from it, so the help page and the parser cannot
# drift: a value option swallows the next word, so `bash --rcfile run.sh`
# is not "run run.sh", and one named like a `set -o` option sets it. The
# ones that change what bash does to its input (restricted mode, the
# string dumps, pretty-printing, the debugger) are refused rather than
# silently ignored.
BASH_LONG_OPTIONS: dict[str, BashLongOption] = {
    **{
        option.long[2:]: (
            BashLongOption.VALUE
            if option.type == "str"
            else BashLongOption.SETTING
            if option.long[2:] in SET_OPTION_NAMES
            else BashLongOption.IGNORE
        )
        for option in SPECS["bash"].options
        if option.long
    },
    "debugger": BashLongOption.UNSUPPORTED,
    "dump-po-strings": BashLongOption.UNSUPPORTED,
    "dump-strings": BashLongOption.UNSUPPORTED,
    "help": BashLongOption.HELP,
    "pretty-print": BashLongOption.UNSUPPORTED,
    "restricted": BashLongOption.UNSUPPORTED,
    "version": BashLongOption.VERSION,
}
