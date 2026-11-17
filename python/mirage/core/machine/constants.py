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

from mirage.types import FileType

# find's type letter for each kind a machine's listing reports; a link
# that resolves to nothing (``l`` under -L), a socket or a block device
# lists as a file, as an SSH listing keeps a broken link's name.
KINDS = {
    "d": FileType.DIRECTORY,
    "f": FileType.FILE,
    "p": FileType.FIFO,
    "c": FileType.CHAR_DEVICE,
}
