-- Compare-and-set one session record: write ARGV[2] under field ARGV[1]
-- only if the stored record's generation equals ARGV[3] (missing = 0).
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local current = 0
if raw then
    local record = cjson.decode(raw)
    if record['generation'] then
        current = tonumber(record['generation'])
    end
end
if current ~= tonumber(ARGV[3]) then
    return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
