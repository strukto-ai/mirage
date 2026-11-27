export const DEFAULT_PORT = 6379

export const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])

export const TRUNCATE_SCRIPT = `
if ARGV[3] == '1' and redis.call('EXISTS', KEYS[1]) == 0 then
    return 0
end
local length = tonumber(ARGV[1])
local current = redis.call('STRLEN', KEYS[1])
if length == 0 then
    redis.call('SET', KEYS[1], '')
elseif length > current then
    redis.call('SETRANGE', KEYS[1], length - 1, string.char(0))
else
    redis.call('SET', KEYS[1], redis.call('GETRANGE', KEYS[1], 0, length - 1))
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`

// Each file a batch names, sized before it is read: one that is absent or
// empty, longer than ARGV[1] bytes, or past what is left of ARGV[2] (no bound
// when empty) once the files before it took theirs answers false.
export const READ_FILES_SCRIPT = `
local limit = tonumber(ARGV[1])
local room = tonumber(ARGV[2])
local out = {}
for i, key in ipairs(KEYS) do
    local size = redis.call('STRLEN', key)
    if size > 0 and size <= limit and (room == nil or size <= room) then
        out[i] = redis.call('GET', key)
        if room ~= nil then
            room = room - size
        end
    else
        out[i] = false
    end
end
return out
`
