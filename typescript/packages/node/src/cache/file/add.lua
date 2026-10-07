-- Insert one cache entry only when the data key is absent: the bytes go
-- under KEYS[1], their fingerprint under KEYS[2], and ARGV[3] carries the
-- TTL in seconds ('' for none). ARGV[2] spells "no fingerprint" the same
-- way, and then KEYS[2] is deleted rather than written: redis evicts the
-- two keys independently, so a meta key can outlive its data key and
-- would otherwise describe the bytes this call installs. Keeping the
-- check, both writes and both expirations in one execution is what makes
-- add() insert-only across processes: a background drain finishing late
-- cannot land between the check and the write and overwrite a newer fill.
-- A meta key already holding this fingerprint is a version kept for longer
-- than the bytes; it keeps the longer bound.
if redis.call('EXISTS', KEYS[1]) ~= 0 then
  return 0
end
local kept = -2
if ARGV[2] ~= '' and redis.call('GET', KEYS[2]) == ARGV[2] then
  kept = redis.call('TTL', KEYS[2])
end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[2], ARGV[2])
else
  redis.call('DEL', KEYS[2])
end
if ARGV[3] ~= '' then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  if ARGV[2] ~= '' then
    if kept > tonumber(ARGV[3]) then
      redis.call('EXPIRE', KEYS[2], kept)
    else
      redis.call('EXPIRE', KEYS[2], ARGV[3])
    end
  end
end
return 1
