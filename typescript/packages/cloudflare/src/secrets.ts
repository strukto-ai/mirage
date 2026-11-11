// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { AWSSMConfig, fetchAwsSmSigned } from '@struktoai/mirage-core/secrets/aws'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'

// The builtin sources a Worker can read, registered on import as node's
// are. `aws-sm` is one signed fetch, so it costs nothing to carry;
// `1password` needs 1Password's SDK in the bundle, so it is its own
// import (onepassword.ts). `env` and `dotenv` read a host process and
// filesystem a Worker doesn't have.
registerSecrets('aws-sm', AWSSMConfig, (config, ref) => fetchAwsSmSigned(config, ref))
