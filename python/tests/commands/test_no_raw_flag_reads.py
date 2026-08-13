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
from pathlib import Path

# The spec layer builds the flag mapping, so it reads and writes it directly.
# Everything downstream goes through FlagView or a typed parameter. The CLI
# walk is spec-layer too: it builds the group-flag bag the way parser.py
# builds the command's.
COMMANDS = Path(__file__).resolve().parents[2] / "mirage" / "commands"
# `config.py` is spec-layer too: the @command wrapper answers --help and
# --version off the bag before the command it wraps ever sees it.
EXEMPT = {
    "spec/parser.py", "spec/shell.py", "spec/types.py", "cli/walk.py",
    "config.py"
}
# Assignment is fine: crossmount fanout builds a bag to hand to the
# sub-commands it dispatches. Only reads have to go through the view.
# The bag reaches a command under three names -- `flags`, and the
# `**kwargs`/`**_extra` a wrapper collects it into -- and a raw read is
# equally blind under all three. `(?<![\w.])` keeps an attribute of the
# same name out (FileStat.extra is not a flag bag).
RAW_READ = re.compile(r"(?<![\w.])(?:flags|kwargs|_extra)"
                      r"(?:\.get\(|\[[^\]]*\](?!\s*=[^=]))")


def test_commands_never_read_the_flag_bag_directly():
    """Flags are read through FlagView or bound to a typed parameter.

    Mirrors the TypeScript no-restricted-syntax rule banning `opts.flags`
    in the generic commands. A raw read of a renamed or misspelled flag
    yields None rather than failing, so nothing catches it: the spelling
    has to be validated against the command's spec instead.
    """
    offenders = []
    for path in sorted(COMMANDS.rglob("*.py")):
        rel = path.relative_to(COMMANDS).as_posix()
        if rel in EXEMPT:
            continue
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if RAW_READ.search(line):
                offenders.append(f"{rel}:{number}: {line.strip()}")
    assert not offenders, (
        "read flags through FlagView(flags, spec=SPECS[...]) "
        "or a typed parameter:\n" + "\n".join(offenders))
