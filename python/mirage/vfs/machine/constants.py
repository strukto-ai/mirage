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

# A mount table's short spelling of a machine mount over every machine at
# the prefix it is given, so Mirage and the machines' programs name a file
# the same way.
LOCAL = "@local"

# The paths a workspace with machines mounts that way unless a mount
# claims them: where programs keep their scratch files.
LOCAL_PREFIXES = ("/tmp", "/dev/shm")
