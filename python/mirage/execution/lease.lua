-- The workspace's lease, held by one daemon at a time: KEYS[1] holds the
-- holder's id. ARGV[1] is a daemon's id. With ARGV[2] 'take' the daemon
-- takes the lease or keeps it, for ARGV[3] milliseconds or, when that is
-- empty, until released, and the id of another daemon whose lease still
-- holds is answered instead. With 'release' the lease goes if ARGV[1]
-- holds it.
local held = redis.call('GET', KEYS[1])
if ARGV[2] == 'release' then
    if held == ARGV[1] then
        redis.call('DEL', KEYS[1])
    end
    return false
end
if held and held ~= ARGV[1] then
    return held
end
if ARGV[3] == '' then
    redis.call('SET', KEYS[1], ARGV[1])
else
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
end
return false
