-- 从最近 200 字记忆队列极速召回命中短语（<0.1ms，无阻塞）
local store = require("recent_store")

local M = {}

function M.func(input, env)
    local ctx = env.engine.context
    local raw = ctx.input or ""
    local comp = ctx.composition
    local seg = (comp and not comp:empty()) and comp:back() or nil
    local start_pos = seg and seg.start or 0
    local end_pos = seg and seg._end or #raw
    local seg_keys = raw:sub(start_pos + 1, end_pos)

    local hits = {}
    if not ctx:get_option("ascii_mode") and #seg_keys >= 2 and #seg_keys <= 32 and seg_keys:match("^[a-z]+$") then
        local ok, res = pcall(store.query, seg_keys)
        if ok and res then
            hits = res
        end
    end

    if #hits == 0 then
        for cand in input:iter() do
            yield(cand)
        end
        return
    end

    local seen = {}
    local rime_cands = {}
    local idx = 0
    for cand in input:iter() do
        if idx == 0 then
            start_pos = cand.start
            end_pos = cand._end
        end
        table.insert(rime_cands, cand)
        idx = idx + 1
        if idx >= 15 then break end
    end

    -- 3 字母及以上（或命中 3 字以上长块）直接放第 1 位；2 字母短码放第 2 位避免抢占极高频词
    local promote_first = (#seg_keys >= 3)
    if not promote_first and #rime_cands >= 1 then
        seen[rime_cands[1].text] = true
        yield(rime_cands[1])
    end

    for _, phrase in ipairs(hits) do
        if not seen[phrase] then
            local c = Candidate("recent", start_pos, end_pos, phrase, "[忆]")
            c.quality = 100
            yield(c)
            seen[phrase] = true
        end
    end

    for _, rc in ipairs(rime_cands) do
        if not seen[rc.text] then
            seen[rc.text] = true
            yield(rc)
        end
    end
    for cand in input:iter() do
        if not seen[cand.text] then
            seen[cand.text] = true
            yield(cand)
        end
    end
end

return M
