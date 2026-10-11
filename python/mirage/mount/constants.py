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

# The most entry stats one SFTP listing keeps in flight. Each is a hop to
# the workspace loop and, on a mount that keeps no listing index, a backend
# request, so a wide directory does not put every one on the wire.
LISTING_CONCURRENCY = 16

# SFTP carries paths as bytes. surrogateescape is the one error policy
# under which every byte survives the str round trip.
ENCODING = "utf-8"
ERRORS = "surrogateescape"

# The SFTP version sshfs and OpenSSH speak.
SFTP_VERSION = 3
