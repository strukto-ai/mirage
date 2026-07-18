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

from mirage.commands.builtin.gdocs.io import IO
from mirage.ops.gdocs.read import read
from mirage.ops.generic import make_generic_ops

# The only read is the dual-resource .gdoc.json filetype op (registered for
# both gdocs and gdrive), so the factory's plain read is overridden.
OPS = [*make_generic_ops("gdocs", IO, overrides={"read"}), read]
