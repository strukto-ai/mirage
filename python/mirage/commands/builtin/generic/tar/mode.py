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

from collections.abc import Sequence

from mirage.commands.spec.compile import expand_table_long
from mirage.commands.spec.constants import TAR_LONG_OPTIONS

_VALUE_LETTERS = "bCfFgGHIKLNTVX"


def _names_a_source_mode(cluster: str) -> bool:
    """Whether an option cluster holds ``c``, ``r`` or ``u``, reading no
    further than a letter whose value is the rest of the word.

    Args:
        cluster (str): the letters after any leading dash.
    """
    for letter in cluster:
        if letter in "cru":
            return True
        if letter in _VALUE_LETTERS:
            return False
    return False


def is_create_mode(argv: Sequence[str]) -> bool:
    """Whether a tar line reads the filesystem rather than an archive.

    ``-c``, ``-r`` and ``-u`` make tar's operands source paths. Under
    ``-t``, ``-x`` and ``--delete`` they are member selectors matched
    against names inside the
    archive, so a selector that happens to spell a mount root is not a
    mount at all and refusing it would deny an ordinary listing.

    Scanned raw because both callers fire before flag parsing: the
    mount-root policy at admission, and the cross-mount router deciding
    whether a span is real. Only the first word may be GNU's dashless
    option cluster (``tar cf a.tar d``), so a later bare word is an
    operand and cannot turn the mode on. ``--`` ends the scan the way
    it ends GNU's option parsing: a later ``-c`` names a member, and
    reading it as the create flag would refuse the very selector fix
    this gate exists to protect (``tar -xf a.tar -C /dst -- -c``). A
    long word is read the way tar's getopt_long reads it, against tar's
    whole table, so an abbreviation (``--crea``) is create too.

    Args:
        argv (Sequence[str]): raw argv after the command name.
    """
    for i, tok in enumerate(argv):
        if not isinstance(tok, str):
            continue
        if tok == "--":
            return False
        if tok.startswith("--"):
            if expand_table_long(TAR_LONG_OPTIONS, tok.split("=", 1)[0]) in (
                ("--create",),
                ("--append",),
                ("--update",),
            ):
                return True
            continue
        if tok.startswith("-"):
            if _names_a_source_mode(tok[1:]):
                return True
            continue
        if i == 0 and _names_a_source_mode(tok):
            return True
    return False
