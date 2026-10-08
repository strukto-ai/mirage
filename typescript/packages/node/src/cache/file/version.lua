-- Keep version ARGV[1] for ARGV[2]s: alone with no bytes, else raise only its own meta key's TTL.
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
  return 1
end
if redis.call('GET', KEYS[2]) == ARGV[1] then
  local left = redis.call('TTL', KEYS[2])
  if left >= 0 and left < tonumber(ARGV[2]) then
    redis.call('EXPIRE', KEYS[2], ARGV[2])
  end
  return 1
end
return 0
