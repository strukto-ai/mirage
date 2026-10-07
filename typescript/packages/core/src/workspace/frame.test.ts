import { expect, it } from 'vitest'
import { ExecutionFrame } from './frame.ts'

it('forks a frame that keeps the abort signal and shares nothing else', () => {
  const frame = new ExecutionFrame()
  frame.diagnostics.push('warning')
  frame.cmdsubSeq = 3
  frame.cmdsubStatus = 1
  frame.abortSignal = new AbortController().signal
  const child = frame.fork()
  child.diagnostics.push('child')
  child.cmdsubSeq += 1
  expect(child.abortSignal).toBe(frame.abortSignal)
  expect(child.diagnostics).toEqual(['child'])
  expect([child.cmdsubSeq, child.cmdsubStatus]).toEqual([1, 0])
  expect(frame.diagnostics).toEqual(['warning'])
  expect([frame.cmdsubSeq, frame.cmdsubStatus]).toEqual([3, 1])
})
