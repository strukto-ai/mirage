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

KUBECTL_HINT = "the kubernetes machine needs `kubectl` on PATH"

# `kubectl get pod` reports status.phase: Pending, Running, Succeeded,
# Failed or Unknown. Only "Running" takes a line.
RUNNING_PHASE = "Running"

# What kubectl prints on its own stderr, then the status and a newline,
# when the program in the pod exits nonzero.
EXIT_PREFIX = b"command terminated with exit code "

# What can follow EXIT_PREFIX while the report arrives: kubectl reads the
# status as one byte, so at most three digits, then the newline.
EXIT_STATUS = re.compile(rb"[0-9]{0,3}|[0-9]{1,3}\n")
