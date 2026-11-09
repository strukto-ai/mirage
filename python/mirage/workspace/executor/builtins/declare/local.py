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

from mirage.workspace.executor.builtins.declare.declare import declared
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session.state import deciding, prefix_temporaries


async def local_builtin(call: BuiltinCall) -> Result:
    """The ``local`` arm, for a name the parser did not read as a
    declaration: its words are the operands, an element's subscript as
    typed.

    Args:
        call (BuiltinCall): the invocation.
    """
    args = list(call.argv.args)
    temporaries = prefix_temporaries(call.context.session)
    return await declared(
        "local",
        lambda shell: shell.declare(
            "local", "", "", args, temporaries, False, deciding()
        ),
        call.context,
        call.execute_fn,
        call.call_stack,
    )
