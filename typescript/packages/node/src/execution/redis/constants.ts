import { readFileSync } from 'node:fs'

export const STORE_LUA = readFileSync(new URL('./store.lua', import.meta.url), 'utf8')
export const POLL_SECONDS = 0.1
