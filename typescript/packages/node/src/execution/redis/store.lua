local records = KEYS[1]
local completed = KEYS[2]
local results = KEYS[3]
local operation = ARGV[1]
local id = ARGV[2]
local cutoff = tonumber(ARGV[3]) - tonumber(ARGV[4])
local maximum = tonumber(ARGV[5])

local function remove(ids)
    for _, key in ipairs(ids) do
        redis.call('HDEL', records, key)
        redis.call('HDEL', results, key)
        redis.call('ZREM', completed, key)
    end
end

local function prune()
    remove(redis.call('ZRANGEBYSCORE', completed, '-inf', cutoff))
    local excess = redis.call('ZCARD', completed) - maximum
    if excess > 0 then
        remove(redis.call('ZRANGE', completed, 0, excess - 1))
    end
end

prune()
if operation == 'get' then
    return {redis.call('HGET', records, id), redis.call('HGET', results, id)}
elseif operation == 'list' then
    return redis.call('HVALS', records)
end

local previous_raw = redis.call('HGET', records, id)
if operation == 'create' then
    if previous_raw then return 0 end
elseif operation == 'cas' then
    if not previous_raw then return 0 end
    local previous = cjson.decode(previous_raw)
    local revision = tonumber(ARGV[7])
    if previous.revision ~= revision or previous.finished_at ~= cjson.null then
        return 0
    end
    local replacement = cjson.decode(ARGV[6])
    if replacement.revision ~= revision + 1 then return -1 end
    if previous.cancel_requested and not replacement.cancel_requested then return -2 end
    if replacement.workspace_id ~= previous.workspace_id
        or replacement.session_id ~= previous.session_id
        or replacement.command ~= previous.command then
        return -3
    end
else
    return redis.error_reply('unknown execution store operation')
end

local replacement = cjson.decode(ARGV[6])
redis.call('HSET', records, id, ARGV[6])
redis.call('HSET', results, id, ARGV[8])
if replacement.finished_at ~= cjson.null then
    redis.call('ZADD', completed, replacement.finished_at, id)
end
prune()
return 1
