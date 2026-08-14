local n = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], tostring(n) .. '-0',
           'c', ARGV[1], 'd', ARGV[2], 't', ARGV[3])
return n
