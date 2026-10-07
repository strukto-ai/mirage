-- Keep KEYS[1]'s version, ARGV[1], where its bytes are not kept, for
-- ARGV[2] seconds: with no data key under KEYS[1], the version goes under
-- KEYS[2] alone with that bound; with data whose meta key KEYS[2] already
-- holds this version, a shorter bound on the meta key is raised to it, so
-- the version outlives the bytes' bound but never lives unbounded unless
-- the bytes do. A meta key holding another version describes bytes someone
-- wrote since, and is left alone. One execution, so a fill landing between
-- the check and the write cannot have its meta key replaced.
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
