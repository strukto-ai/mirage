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

import {
  makeFiletypeCommands,
  makeResolveGlob,
  ResourceName,
  withDefaultProvisions,
  type RegisteredCommand,
} from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'
import { SCOPE_ERROR } from '../../../core/opfs/constants.ts'
import { read as opfsRead } from '../../../core/opfs/read.ts'
import { readdir as opfsReaddir } from '../../../core/opfs/readdir.ts'
import { stat as opfsStat } from '../../../core/opfs/stat.ts'
import { OPFS_AWK } from './awk.ts'
import { OPFS_BASE64 } from './base64_cmd.ts'
import { OPFS_BASENAME } from './basename.ts'
import { OPFS_CAT } from './cat/cat.ts'
import { OPFS_CMP } from './cmp.ts'
import { OPFS_COLUMN } from './column.ts'
import { OPFS_COMM } from './comm.ts'
import { OPFS_CP } from './cp.ts'
import { OPFS_CSPLIT } from './csplit.ts'
import { OPFS_CUT } from './cut/cut.ts'
import { OPFS_DIFF } from './diff.ts'
import { OPFS_DIRNAME } from './dirname.ts'
import { OPFS_DU } from './du.ts'
import { OPFS_EXPAND } from './expand.ts'
import { OPFS_FILE } from './file/file.ts'
import { OPFS_FIND } from './find.ts'
import { OPFS_FMT } from './fmt.ts'
import { OPFS_FOLD } from './fold.ts'
import { OPFS_GREP } from './grep/grep.ts'
import { OPFS_GUNZIP } from './gunzip.ts'
import { OPFS_GZIP } from './gzip.ts'
import { OPFS_HEAD } from './head/head.ts'
import { OPFS_ICONV } from './iconv.ts'
import { OPFS_JOIN } from './join.ts'
import { OPFS_JQ } from './jq.ts'
import { OPFS_LN } from './ln.ts'
import { OPFS_LOOK } from './look.ts'
import { OPFS_LS } from './ls/ls.ts'
import { OPFS_MD5 } from './md5.ts'
import { OPFS_MD5SUM } from './md5sum.ts'
import { OPFS_MKDIR } from './mkdir.ts'
import { OPFS_MKTEMP } from './mktemp.ts'
import { OPFS_MV } from './mv.ts'
import { OPFS_NL } from './nl.ts'
import { OPFS_PASTE } from './paste.ts'
import { OPFS_PATCH } from './patch.ts'
import { OPFS_READLINK } from './readlink.ts'
import { OPFS_REALPATH } from './realpath.ts'
import { OPFS_REV } from './rev.ts'
import { OPFS_RG } from './rg.ts'
import { OPFS_RM } from './rm.ts'
import { OPFS_RMDIR } from './rmdir.ts'
import { OPFS_SED } from './sed.ts'
import { OPFS_SHA1SUM } from './sha1sum.ts'
import { OPFS_SHA256SUM } from './sha256sum.ts'
import { OPFS_SHA384SUM } from './sha384sum.ts'
import { OPFS_SHA512SUM } from './sha512sum.ts'
import { OPFS_SHUF } from './shuf.ts'
import { OPFS_SORT } from './sort.ts'
import { OPFS_SPLIT } from './split.ts'
import { OPFS_STAT } from './stat/stat.ts'
import { OPFS_STRINGS } from './strings.ts'
import { OPFS_TAC } from './tac.ts'
import { OPFS_TAIL } from './tail/tail.ts'
import { OPFS_TAR } from './tar.ts'
import { OPFS_TEE } from './tee.ts'
import { OPFS_TOUCH } from './touch.ts'
import { OPFS_TR } from './tr.ts'
import { OPFS_TREE } from './tree.ts'
import { OPFS_TSORT } from './tsort.ts'
import { OPFS_UNEXPAND } from './unexpand.ts'
import { OPFS_UNIQ } from './uniq.ts'
import { OPFS_UNLINK } from './unlink.ts'
import { OPFS_UNZIP } from './unzip.ts'
import { OPFS_WC } from './wc/wc.ts'
import { OPFS_XXD } from './xxd.ts'
import { OPFS_ZCAT } from './zcat.ts'
import { OPFS_ZGREP } from './zgrep.ts'
import { OPFS_ZIP } from './zip_cmd.ts'

const opfsResolveGlob = makeResolveGlob(opfsReaddir, SCOPE_ERROR)

// Bespoke commands get the same family-default provisions the factory
// would attach, so estimates match factory-built backends.
export const OPFS_COMMANDS: readonly RegisteredCommand[] = withDefaultProvisions(
  [
    ...makeFiletypeCommands<OPFSAccessor>({
      resource: ResourceName.OPFS,
      readBytes: opfsRead,
      statEntry: opfsStat,
    }),
    ...OPFS_AWK,
    ...OPFS_BASE64,
    ...OPFS_BASENAME,
    ...OPFS_CAT,
    ...OPFS_CMP,
    ...OPFS_COLUMN,
    ...OPFS_COMM,
    ...OPFS_CP,
    ...OPFS_CSPLIT,
    ...OPFS_CUT,
    ...OPFS_DIFF,
    ...OPFS_DIRNAME,
    ...OPFS_DU,
    ...OPFS_EXPAND,
    ...OPFS_FILE,
    ...OPFS_FIND,
    ...OPFS_FMT,
    ...OPFS_FOLD,
    ...OPFS_GREP,
    ...OPFS_GUNZIP,
    ...OPFS_GZIP,
    ...OPFS_HEAD,
    ...OPFS_ICONV,
    ...OPFS_JOIN,
    ...OPFS_JQ,
    ...OPFS_LN,
    ...OPFS_LOOK,
    ...OPFS_LS,
    ...OPFS_MD5,
    ...OPFS_MD5SUM,
    ...OPFS_MKDIR,
    ...OPFS_MKTEMP,
    ...OPFS_MV,
    ...OPFS_NL,
    ...OPFS_PASTE,
    ...OPFS_PATCH,
    ...OPFS_READLINK,
    ...OPFS_REALPATH,
    ...OPFS_REV,
    ...OPFS_RG,
    ...OPFS_RM,
    ...OPFS_RMDIR,
    ...OPFS_SED,
    ...OPFS_SHA1SUM,
    ...OPFS_SHA256SUM,
    ...OPFS_SHA384SUM,
    ...OPFS_SHA512SUM,
    ...OPFS_SHUF,
    ...OPFS_SORT,
    ...OPFS_SPLIT,
    ...OPFS_STAT,
    ...OPFS_STRINGS,
    ...OPFS_TAC,
    ...OPFS_TAIL,
    ...OPFS_TAR,
    ...OPFS_TEE,
    ...OPFS_TOUCH,
    ...OPFS_TR,
    ...OPFS_TREE,
    ...OPFS_TSORT,
    ...OPFS_UNEXPAND,
    ...OPFS_UNIQ,
    ...OPFS_UNLINK,
    ...OPFS_UNZIP,
    ...OPFS_WC,
    ...OPFS_XXD,
    ...OPFS_ZCAT,
    ...OPFS_ZGREP,
    ...OPFS_ZIP,
  ],
  opfsStat,
  opfsResolveGlob,
  opfsReaddir,
)
