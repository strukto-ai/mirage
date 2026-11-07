-- Keep one record, ARGV[2], under its id, ARGV[1], in the hash KEYS[1]. An
-- ended one (ARGV[3], its end) joins the sorted set KEYS[2], which keeps the
-- newest ARGV[4] that ended within ARGV[5] seconds of it; the rest leave both
-- keys. A running one leaves the set. Both keys expire ARGV[6] seconds after
-- the last write.
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] == '' then
    redis.call('ZREM', KEYS[2], ARGV[1])
else
    local ended = tonumber(ARGV[3])
    redis.call('ZADD', KEYS[2], ended, ARGV[1])
    local cutoff = '(' .. tostring(ended - tonumber(ARGV[5]))
    for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', cutoff)) do
        redis.call('HDEL', KEYS[1], id)
    end
    redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
    local over = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
    if over > 0 then
        for _, id in ipairs(redis.call('ZRANGE', KEYS[2], 0, over - 1)) do
            redis.call('HDEL', KEYS[1], id)
        end
        redis.call('ZREMRANGEBYRANK', KEYS[2], 0, over - 1)
    end
end
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('EXPIRE', KEYS[2], ARGV[6])
return 0
