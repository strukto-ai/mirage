-- Raise the workspace's highest pid, KEYS[1], to ARGV[1]; it never falls.
if tonumber(ARGV[1]) > tonumber(redis.call('GET', KEYS[1]) or '0') then
    redis.call('SET', KEYS[1], ARGV[1])
end
return 0
