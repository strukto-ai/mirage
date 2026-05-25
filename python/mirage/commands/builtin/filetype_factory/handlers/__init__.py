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

from mirage.commands.builtin.filetype_factory.handlers.cat import _ft_cat
from mirage.commands.builtin.filetype_factory.handlers.cut import _ft_cut
from mirage.commands.builtin.filetype_factory.handlers.file import _ft_file
from mirage.commands.builtin.filetype_factory.handlers.grep import _ft_grep
from mirage.commands.builtin.filetype_factory.handlers.head import _ft_head
from mirage.commands.builtin.filetype_factory.handlers.rg import _ft_rg
from mirage.commands.builtin.filetype_factory.handlers.stat import _ft_stat
from mirage.commands.builtin.filetype_factory.handlers.tail import _ft_tail
from mirage.commands.builtin.filetype_factory.handlers.wc import _ft_wc

_BUILDERS = (
    ("cat", _ft_cat),
    ("head", _ft_head),
    ("tail", _ft_tail),
    ("wc", _ft_wc),
    ("stat", _ft_stat),
    ("cut", _ft_cut),
    ("file", _ft_file),
    ("grep", _ft_grep),
    ("rg", _ft_rg),
)

__all__ = [
    "_BUILDERS",
    "_ft_cat",
    "_ft_cut",
    "_ft_file",
    "_ft_grep",
    "_ft_head",
    "_ft_rg",
    "_ft_stat",
    "_ft_tail",
    "_ft_wc",
]
