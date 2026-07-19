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

from mirage.commands.builtin.email.email_forward import email_forward
from mirage.commands.builtin.email.email_read import email_read
from mirage.commands.builtin.email.email_reply import email_reply
from mirage.commands.builtin.email.email_send import email_send
from mirage.commands.builtin.email.email_triage import email_triage
from mirage.commands.builtin.email.find import find
from mirage.commands.builtin.email.grep import grep
from mirage.commands.builtin.email.io import IO as _IO
from mirage.commands.builtin.email.rg import rg
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.core.email.read import read as _read

_EMAIL_OVERRIDES = {"find", "grep", "rg"}

COMMANDS = [
    *make_filetype_commands(
        "email", _IO.resolve_glob, _read, read_takes_index=True),
    *make_generic_commands(
        "email",
        _IO,
        overrides=_EMAIL_OVERRIDES,
    ),
    find,
    grep,
    rg,
    email_send,
    email_reply,
    email_forward,
    email_triage,
    email_read,
]
