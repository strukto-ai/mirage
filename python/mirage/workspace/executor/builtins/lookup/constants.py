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

from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.route import Consumer

TYPE_USAGE = "type: usage: type [-afptP] name [name ...]\n"
WHICH_USAGE = "which: usage: which [-as] name [name ...]\n"

# The words each builtin accepts, as bash's usage line spells them.
TYPE_OPTIONS = "afptP"
WHICH_OPTIONS = "as"

# Shell builtins, namespace commands and mount commands are all
# in-process and pathless, so they share bash's runnable-and-in-process
# category. That collapse is deliberate; `cli` is kept apart because an
# installed CLI is the one runnable an agent cannot otherwise discover.
# UNKNOWN is absent: it is what `route` reports for a name no layer
# holds, and `route_all` never yields it.
KIND_BY_CONSUMER: dict[Consumer, NameKind] = {
    Consumer.SESSION: NameKind.BUILTIN,
    Consumer.NAMESPACE: NameKind.BUILTIN,
    Consumer.FUNCTION: NameKind.FUNCTION,
    Consumer.CLI: NameKind.CLI,
    Consumer.MOUNT: NameKind.BUILTIN,
}

DESCRIPTIONS: dict[NameKind, str] = {
    NameKind.KEYWORD: "a shell keyword",
    NameKind.FUNCTION: "a function",
    NameKind.CLI: "a mirage CLI",
    NameKind.BUILTIN: "a shell builtin",
}
