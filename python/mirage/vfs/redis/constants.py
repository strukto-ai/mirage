DEFAULT_PORT = 6379

LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})

TRUNCATE_SCRIPT = """
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
"""
