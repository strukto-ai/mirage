import { expect, it } from 'vitest'
import {
  DEFAULT_PROCESS_PERMISSIONS,
  layerProcesses,
  nearer,
  restrictProcesses,
  statedProcesses,
} from './config.ts'
import { MAX_PROCESSES } from './constants.ts'

it('an unstated block caps at MAX_PROCESSES', () => {
  expect(DEFAULT_PROCESS_PERMISSIONS).toEqual({
    list: 'session',
    kill: 'session',
    max: MAX_PROCESSES,
  })
  expect(layerProcesses([{ max: null }]).max).toBeNull()
  expect(statedProcesses({ max: 4 })).toEqual({ max: 4 })
})

it('layers each field from the nearest block that states it', () => {
  const workspace = { list: 'workspace', kill: 'workspace', max: 4 } as const
  expect(layerProcesses([{ max: 9 }, workspace])).toEqual({ ...workspace, max: 9 })
  expect(layerProcesses([null, workspace])).toEqual(workspace)
  expect(layerProcesses([{ max: null }, workspace]).max).toBeNull()
  expect(layerProcesses([null, undefined])).toEqual(DEFAULT_PROCESS_PERMISSIONS)
})

it('keeps an inherited kill within the list above it', () => {
  const layered = layerProcesses([{ list: 'session' }, 'workspace'])
  expect([layered.list, layered.kill]).toEqual(['session', 'session'])
})

it('restricts only the fields the inline block states', () => {
  const own = layerProcesses([{ list: 'workspace', kill: 'workspace', max: 9 }])
  expect(restrictProcesses(own, { max: 2 })).toEqual({ ...own, max: 2 })
  expect(restrictProcesses(own, { list: 'session' })).toEqual(layerProcesses([{ max: 9 }]))
  expect(restrictProcesses(layerProcesses([{ max: null }]), { max: 5 }).max).toBe(5)
})

it('still refuses one block whose kill reaches past its own list', () => {
  expect(() => statedProcesses({ list: 'session', kill: 'workspace' })).toThrow(
    'processes.kill cannot reach past processes.list',
  )
})

it('nearer is the narrower scope', () => {
  expect(nearer('workspace', 'session')).toBe('session')
  expect(nearer('workspace', 'workspace')).toBe('workspace')
})
