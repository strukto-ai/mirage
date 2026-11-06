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

from mirage.resources.types import EntryKind, ResourceKind

ENTRY_KINDS: tuple[EntryKind, ...] = ("vfs", "cli", "runtime", "store")

# The one scope a local daemon serves; a hosted server keeps one per team.
DEFAULT_SCOPE = "local"

# A saved config's name, which is also safe as a file name.
NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,62}")

# The source a config names a saved field through: {from: strukto, ref, key}.
STRUKTO = "strukto"

# The folder deleted templates wait in until restored.
DELETED_TEMPLATES = ".deleted/template"

NOUN: dict[ResourceKind, str] = {
    "vfs": "VFS",
    "cli": "CLI",
    "runtime": "runtime",
    "store": "secret store",
    "policy": "policy",
    "template": "template",
}
