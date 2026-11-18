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

import asyncssh

from mirage.types import FileType

SFTP_TYPES = {
    FileType.FILE: asyncssh.FILEXFER_TYPE_REGULAR,
    FileType.DIRECTORY: asyncssh.FILEXFER_TYPE_DIRECTORY,
    FileType.SYMLINK: asyncssh.FILEXFER_TYPE_SYMLINK,
    FileType.CHAR_DEVICE: asyncssh.FILEXFER_TYPE_CHAR_DEVICE,
    FileType.BLOCK_DEVICE: asyncssh.FILEXFER_TYPE_BLOCK_DEVICE,
    FileType.SOCKET: asyncssh.FILEXFER_TYPE_SOCKET,
    FileType.FIFO: asyncssh.FILEXFER_TYPE_FIFO,
}
SFTP_KINDS = {value: kind for kind, value in SFTP_TYPES.items()}

SCOPE_ERROR = 5000

# SFTP open flags: write, creating a missing file and truncating none.
FXF_WRITE = 0x00000002
FXF_CREAT = 0x00000008
