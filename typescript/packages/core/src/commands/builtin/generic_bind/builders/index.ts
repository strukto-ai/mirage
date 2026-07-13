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

import type { Builder } from '../adapter.ts'
import { AWK_BUILDER } from './awk.ts'
import { BASE64_BUILDER } from './base64.ts'
import { BASENAME_BUILDER } from './basename.ts'
import { CAT_BUILDER } from './cat.ts'
import { CMP_BUILDER } from './cmp.ts'
import { COLUMN_BUILDER } from './column.ts'
import { COMM_BUILDER } from './comm.ts'
import { CP_BUILDER } from './cp.ts'
import { CSPLIT_BUILDER } from './csplit.ts'
import { CUT_BUILDER } from './cut.ts'
import { DIFF_BUILDER } from './diff.ts'
import { DIRNAME_BUILDER } from './dirname.ts'
import { DU_BUILDER } from './du.ts'
import { EXPAND_BUILDER } from './expand.ts'
import { FILE_BUILDER } from './file.ts'
import { FIND_BUILDER } from './find.ts'
import { FMT_BUILDER } from './fmt.ts'
import { FOLD_BUILDER } from './fold.ts'
import { GREP_BUILDER } from './grep.ts'
import { GUNZIP_BUILDER } from './gunzip.ts'
import { GZIP_BUILDER } from './gzip.ts'
import { HEAD_BUILDER } from './head.ts'
import { ICONV_BUILDER } from './iconv.ts'
import { JOIN_BUILDER } from './join.ts'
import { JQ_BUILDER } from './jq.ts'
import { LN_BUILDER } from './ln.ts'
import { LOOK_BUILDER } from './look.ts'
import { LS_BUILDER } from './ls.ts'
import { MD5_BUILDER } from './md5.ts'
import { MKDIR_BUILDER } from './mkdir.ts'
import { MKTEMP_BUILDER } from './mktemp.ts'
import { MV_BUILDER } from './mv.ts'
import { NL_BUILDER } from './nl.ts'
import { PASTE_BUILDER } from './paste.ts'
import { PATCH_BUILDER } from './patch.ts'
import { READLINK_BUILDER } from './readlink.ts'
import { REALPATH_BUILDER } from './realpath.ts'
import { REV_BUILDER } from './rev.ts'
import { RG_BUILDER } from './rg.ts'
import { RM_BUILDER } from './rm.ts'
import { SED_BUILDER } from './sed.ts'
import { SHA256SUM_BUILDER } from './sha256sum.ts'
import { SHUF_BUILDER } from './shuf.ts'
import { SORT_BUILDER } from './sort.ts'
import { SPLIT_BUILDER } from './split.ts'
import { STAT_BUILDER } from './stat.ts'
import { STRINGS_BUILDER } from './strings.ts'
import { TAC_BUILDER } from './tac.ts'
import { TAIL_BUILDER } from './tail.ts'
import { TAR_BUILDER } from './tar.ts'
import { TEE_BUILDER } from './tee.ts'
import { TOUCH_BUILDER } from './touch.ts'
import { TR_BUILDER } from './tr.ts'
import { TREE_BUILDER } from './tree.ts'
import { TSORT_BUILDER } from './tsort.ts'
import { UNEXPAND_BUILDER } from './unexpand.ts'
import { UNIQ_BUILDER } from './uniq.ts'
import { UNZIP_BUILDER } from './unzip.ts'
import { WC_BUILDER } from './wc.ts'
import { XXD_BUILDER } from './xxd.ts'
import { ZCAT_BUILDER } from './zcat.ts'
import { ZGREP_BUILDER } from './zgrep.ts'
import { ZIP_BUILDER } from './zip_cmd.ts'

export const BUILDERS: readonly Builder[] = [
  AWK_BUILDER,
  BASE64_BUILDER,
  BASENAME_BUILDER,
  CAT_BUILDER,
  CMP_BUILDER,
  COLUMN_BUILDER,
  COMM_BUILDER,
  CP_BUILDER,
  CSPLIT_BUILDER,
  CUT_BUILDER,
  DIFF_BUILDER,
  DIRNAME_BUILDER,
  DU_BUILDER,
  EXPAND_BUILDER,
  FILE_BUILDER,
  FIND_BUILDER,
  FMT_BUILDER,
  FOLD_BUILDER,
  GREP_BUILDER,
  GUNZIP_BUILDER,
  GZIP_BUILDER,
  HEAD_BUILDER,
  ICONV_BUILDER,
  JOIN_BUILDER,
  JQ_BUILDER,
  LN_BUILDER,
  LOOK_BUILDER,
  LS_BUILDER,
  MD5_BUILDER,
  MKDIR_BUILDER,
  MKTEMP_BUILDER,
  MV_BUILDER,
  NL_BUILDER,
  PASTE_BUILDER,
  PATCH_BUILDER,
  READLINK_BUILDER,
  REALPATH_BUILDER,
  REV_BUILDER,
  RG_BUILDER,
  RM_BUILDER,
  SED_BUILDER,
  SHA256SUM_BUILDER,
  SHUF_BUILDER,
  SORT_BUILDER,
  SPLIT_BUILDER,
  STAT_BUILDER,
  STRINGS_BUILDER,
  TAC_BUILDER,
  TAIL_BUILDER,
  TAR_BUILDER,
  TEE_BUILDER,
  TOUCH_BUILDER,
  TR_BUILDER,
  TREE_BUILDER,
  TSORT_BUILDER,
  UNEXPAND_BUILDER,
  UNIQ_BUILDER,
  UNZIP_BUILDER,
  WC_BUILDER,
  XXD_BUILDER,
  ZCAT_BUILDER,
  ZGREP_BUILDER,
  ZIP_BUILDER,
]
