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

from mirage.types import PathSpec

# The root working directory, as CommandOpts.cwd defaults to it: the
# promoted shape execute_cmd gives "/" on an unprefixed mount. A frozen
# PathSpec, so one instance serves as the field default. The TS twin
# (commands/constants.ts) holds the pre-promotion string, because the
# TS CommandOpts keeps cwd as a virtual-path string.
ROOT_CWD = PathSpec(virtual="/", directory="/", vfs_path="", resolved=False)
