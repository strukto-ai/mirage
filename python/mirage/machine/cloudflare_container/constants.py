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

# A handle with neither a container nor a relay has nothing to reach.
NO_CONTAINER = (
    "cloudflare_container needs the container: set url and token to reach "
    "it through a ContainerRelay"
)

# A container handed in has no relay to name.
BOTH = "cloudflare_container takes a container or a relay url, not both"

# A relay's container is the user's, so nothing here sleeps it.
SLEEP_RELAY = (
    "cloudflare_container takes no sleep hook with a relay url: "
    "a relay's container is the user's"
)

# What a line the container stopped under says, after the provider's name.
STOPPED = "the container stopped; the next line starts it again"

# Why a closing workspace does not reach a container that has stopped.
CLOSING = "the container has stopped, and closing the workspace starts none"

# How often a container that was just started is asked the check line, and
# for how long: most answer within a second, but one start of 33 on real
# Cloudflare took 32 s.
CHECK_POLL_SECONDS = 0.1
START_WAIT_SECONDS = 60

NOT_ANSWERING = (
    f"the container did not answer within {START_WAIT_SECONDS}s of starting"
)

# The relay's three calls, each a path segment after the url that names the
# container: start it, run one exec over a socket, hear when it exits.
RELAY_START = "start"
RELAY_EXEC = "exec"
RELAY_MONITOR = "monitor"

# The secret a relay checks every call's token against.
RELAY_TOKEN = "MIRAGE_RELAY_TOKEN"

# The byte before each chunk of output on an exec's socket: its stream.
STDOUT_CHANNEL = 1
STDERR_CHANNEL = 2

# How many bytes each direction of a relayed exec may have in flight
# before the sender waits: output the client has not read, input the
# program has not taken.
RELAY_WINDOW_BYTES = 1 << 20

# How often a relay speaks on a quiet socket, so nothing between drops it
# as idle.
RELAY_HEARTBEAT_SECONDS = 30
