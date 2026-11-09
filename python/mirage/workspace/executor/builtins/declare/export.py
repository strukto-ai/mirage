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

from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.declare.declare import mark_names
from mirage.workspace.executor.builtins.types import BuiltinCall, Result


async def export_builtin(call: BuiltinCall) -> Result:
    """The ``export`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await mark_names(
        list(call.argv.args),
        call.context,
        call.execute_fn,
        call.call_stack,
        VarAttr.EXPORT,
    )
