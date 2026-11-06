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

import { describe, expect, it } from 'vitest'
import {
  signalDescription,
  signalName,
  signalNumber,
  signalReport,
  signalTable,
} from './signals.ts'

const VOICE = 'bash: line 1: '

describe('signals', () => {
  it('names a signal as kill -l does', () => {
    expect(signalName(2)).toBe('INT')
    expect(signalName(34)).toBe('RTMIN')
    expect(signalName(35)).toBe('RTMIN+1')
    expect(signalName(49)).toBe('RTMIN+15')
    expect(signalName(50)).toBe('RTMAX-14')
    expect(signalName(64)).toBe('RTMAX')
    expect(signalName(32)).toBeNull()
    expect(signalName(65)).toBeNull()
  })

  it('reads every spelling bash takes', () => {
    expect(signalNumber('sigint')).toBe(2)
    expect(signalNumber(' +9')).toBe(9)
    expect(signalNumber('EXIT')).toBe(0)
    expect(signalNumber('RTMIN+30')).toBe(64)
    expect(signalNumber('RTMAX-14')).toBe(50)
    expect(signalNumber('RTMAX-15')).toBeNull()
    expect(signalNumber('65')).toBeNull()
    expect(signalNumber('INTÄ')).toBeNull()
  })

  it('describes what a report line says', () => {
    expect(signalDescription(9)).toBe('Killed')
    expect(signalDescription(15)).toBe('Terminated')
    expect(signalDescription(34)).toBe('Real-time signal 0')
    expect(signalDescription(13)).toBe('Broken pipe')
    expect(signalDescription(17)).toBeNull()
  })

  it('reports the last process a signal ended', () => {
    expect(signalReport(VOICE, [[9, 137, 9, 'sleep 3']], true)).toBe(
      'bash: line 1:     9 Killed                  sleep 3\n',
    )
    expect(signalReport(VOICE, [[9, 0, null, 'true']], true)).toBe('')
    expect(signalReport(VOICE, [[9, 130, 2, 'sleep 3']], true)).toBe('')
    expect(signalReport(VOICE, [[9, 141, 13, 'yes']], true)).toBe('')
  })

  it('tells of TERM only in the foreground', () => {
    expect(signalReport(VOICE, [[9, 143, 15, 'sleep 3']], true)).toBe('Terminated\n')
    expect(signalReport(VOICE, [[9, 143, 15, 'sleep 3']], false)).toBe('')
    expect(signalReport(VOICE, [[9, 129, 1, 'sleep 3']], false)).toBe(
      'bash: line 1:     9 Hangup                  sleep 3\n',
    )
  })

  it('lists a pipeline under its first stage', () => {
    expect(
      signalReport(
        VOICE,
        [
          [11, 0, null, 'true'],
          [12, 3, null, 'exit 3'],
          [13, 137, 9, 'sh'],
          [14, 137, 9, 'sh'],
          [15, 141, 13, 'yes'],
          [16, 129, 1, 'sh'],
        ],
        true,
      ).split('\n'),
    ).toEqual([
      'bash: line 1:    11 Done                    true',
      '        12 Exit 3                  | exit 3',
      '        13 Killed                  | sh',
      '        14                       | sh',
      '        15 Broken pipe             | yes',
      '        16 Hangup                  | sh',
      '',
    ])
  })

  it('lists five signals to a line', () => {
    const lines = signalTable().split('\n')
    expect(lines[0]).toBe(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP')
    expect(lines[1]?.startsWith(' 6) SIGABRT\t')).toBe(true)
    expect(signalTable()).not.toContain('32)')
  })
})
