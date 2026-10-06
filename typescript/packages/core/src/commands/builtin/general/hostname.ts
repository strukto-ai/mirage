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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()

// The node name uname -n prints: the one name every host answers with.
const HOSTNAME = 'mirage'

// What each display option prints, as a Debian host with no DNS domain whose
// /etc/hosts maps its name to 127.0.1.1; null is the unset NIS domain.
const DISPLAY: Readonly<Record<string, string | null>> = {
  short: `${HOSTNAME}\n`,
  fqdn: `${HOSTNAME}\n`,
  long: `${HOSTNAME}\n`,
  domain: '',
  alias: '\n',
  all_fqdns: '\n',
  ip_address: '127.0.1.1\n',
  all_ip_addresses: '\n',
  yp: null,
  nis: null,
}
const NOT_ROOT = 'hostname: you must be root to change the host name\n'
const NO_NIS_DOMAIN = 'hostname: Local domain name not set\n'
// hostname 3.25's usage block, which it prints to stderr, exit 255, when the
// operands do not fit.
const USAGE =
  'Usage: hostname [-b] {hostname|-F file}         set host name (from file)\n' +
  '       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name\n' +
  '       hostname                                 display host name\n\n' +
  '       {yp,nis,}domainname {nisdomain|-F file}  set NIS domain name (from file)\n' +
  '       {yp,nis,}domainname                      display NIS domain name\n\n' +
  '       dnsdomainname                            display dns domain name\n\n' +
  '       hostname -V|--version|-h|--help          print info and exit\n\n' +
  'Program name:\n' +
  '       {yp,nis,}domainname=hostname -y\n' +
  '       dnsdomainname=hostname -d\n\n' +
  'Program options:\n' +
  '    -a, --alias            alias names\n' +
  '    -A, --all-fqdns        all long host names (FQDNs)\n' +
  '    -b, --boot             set default hostname if none available\n' +
  '    -d, --domain           DNS domain name\n' +
  '    -f, --fqdn, --long     long host name (FQDN)\n' +
  '    -F, --file             read host name or NIS domain name from given file\n' +
  '    -i, --ip-address       addresses for the host name\n' +
  '    -I, --all-ip-addresses all addresses for the host\n' +
  '    -s, --short            short host name\n' +
  '    -y, --yp, --nis        NIS/YP domain name\n\n' +
  'Description:\n' +
  '   This command can get or set the host name or the NIS domain name. You can\n' +
  '   also get the DNS domain or the FQDN (fully qualified domain name).\n' +
  '   Unless you are using bind or NIS for host lookups you can change the\n' +
  '   FQDN (Fully Qualified Domain Name) and the DNS domain name (which is\n' +
  '   part of the FQDN) in the /etc/hosts file.\n'

// hostname 3.25 (Debian): the name uname -n prints, never the host's. The last
// display option wins, and setting a name is the refusal an unprivileged user
// gets.
function hostname(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  const fl = new FlagView(opts.flags, specOf('hostname'))
  const typed = fl.typedOrder(...Object.keys(DISPLAY))
  if (texts.length > 1 || (texts.length > 0 && typed.length > 0)) {
    return [null, new IOResult({ exitCode: 255, stderr: ENC.encode(USAGE) })]
  }
  if (texts.length > 0 || fl.asStr('file') !== undefined) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(NOT_ROOT) })]
  }
  const shown = DISPLAY[typed.at(-1) ?? 'short']
  if (shown === null || shown === undefined) {
    return [ENC.encode(NO_NIS_DOMAIN), new IOResult({ exitCode: 1 })]
  }
  return [ENC.encode(shown), new IOResult()]
}

export const GENERAL_HOSTNAME = command({
  name: 'hostname',
  vfs: null,
  spec: specOf('hostname'),
  fn: hostname,
})
