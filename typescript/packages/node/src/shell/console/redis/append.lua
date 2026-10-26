local n = tonumber(redis.call('GET', KEYS[2]) or '0')
if redis.call('EXISTS', KEYS[3]) == 1 then
  return n
end
n = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], tostring(n) .. '-0',
           'c', ARGV[1], 'd', ARGV[2], 't', ARGV[3])
if ARGV[4] == '1' then
  redis.call('SET', KEYS[3], '1')
end
local ttl = tonumber(ARGV[5])
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
end
return n
