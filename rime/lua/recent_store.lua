-- 最近 200 字短期语句记忆队列（按长到短切块 + 全拼/简拼/轻容错即时召回）
-- 纯内存运行，<0.1ms 查询，Windows 与 Android 通用

local char_py = require("char_py")

local M = {
    MAX_QUEUE_CHARS = 800,
    MAX_CHUNK_LEN = 6,
    MIN_CHUNK_LEN = 2,
    pending = nil,        -- { text = "...", ts = 0, chars = 0 }
    queue = {},           -- 列表: { text = "...", ts = 0, seq = 0 }
    total_chars = 0,
    seq = 0,
    chunks = {},          -- phrase -> { phrase, chars, len, seq, sylls_list }
    first_bucket = {},    -- first_initial -> { phrase, ... }
}

local function utf8_chars(text)
    local arr = {}
    for _, code in utf8.codes(text) do
        table.insert(arr, utf8.char(code))
    end
    return arr
end

local function is_cjk_code(code)
    return code >= 0x4E00 and code <= 0x9FFF
end

-- 从一段连续汉字提取所有可能读音组合（控制分支上限防多音字爆炸）
local function build_sylls_list(char_arr)
    local lists = { {} }
    for _, ch in ipairs(char_arr) do
        local pys = char_py[ch]
        if not pys or #pys == 0 then
            return nil
        end
        local next_lists = {}
        for _, prefix in ipairs(lists) do
            for j = 1, math.min(#pys, 2) do
                local copy = {}
                for k = 1, #prefix do copy[k] = prefix[k] end
                copy[#copy + 1] = pys[j]
                next_lists[#next_lists + 1] = copy
                if #next_lists >= 6 then break end
            end
            if #next_lists >= 6 then break end
        end
        lists = next_lists
    end
    return lists
end

local function rebuild_chunks()
    M.chunks = {}
    M.first_bucket = {}

    for _, item in ipairs(M.queue) do
        -- 按标点/非汉字拆分成连续汉字片段
        local runs = {}
        local cur = {}
        for _, code in utf8.codes(item.text) do
            if is_cjk_code(code) then
                cur[#cur + 1] = utf8.char(code)
            else
                if #cur >= M.MIN_CHUNK_LEN then
                    runs[#runs + 1] = cur
                end
                cur = {}
            end
        end
        if #cur >= M.MIN_CHUNK_LEN then
            runs[#runs + 1] = cur
        end

        for _, run in ipairs(runs) do
            local n = #run
            local max_l = math.min(n, M.MAX_CHUNK_LEN)
            -- 按从长到短切块
            for L = max_l, M.MIN_CHUNK_LEN, -1 do
                for s = 1, n - L + 1 do
                    local sub = {}
                    for k = s, s + L - 1 do
                        sub[#sub + 1] = run[k]
                    end
                    local phrase = table.concat(sub)
                    local existing = M.chunks[phrase]
                    if existing then
                        if item.seq > existing.seq then
                            existing.seq = item.seq
                        end
                    else
                        local sylls_list = build_sylls_list(sub)
                        if sylls_list and #sylls_list > 0 then
                            local rec = {
                                phrase = phrase,
                                len = L,
                                seq = item.seq,
                                sylls_list = sylls_list,
                            }
                            M.chunks[phrase] = rec
                            local seen_init = {}
                            for _, sylls in ipairs(sylls_list) do
                                local fi = sylls[1]:sub(1, 1)
                                if not seen_init[fi] then
                                    seen_init[fi] = true
                                    local b = M.first_bucket[fi]
                                    if not b then
                                        b = {}
                                        M.first_bucket[fi] = b
                                    end
                                    b[#b + 1] = rec
                                end
                            end
                        end
                    end
                end
            end
        end
    end
end

local function push_committed_text(text, ts)
    local chars = utf8_chars(text)
    if #chars == 0 then return end
    M.seq = M.seq + 1
    table.insert(M.queue, { text = text, chars = #chars, ts = ts, seq = M.seq })
    M.total_chars = M.total_chars + #chars

    while M.total_chars > M.MAX_QUEUE_CHARS and #M.queue > 1 do
        local dropped = table.remove(M.queue, 1)
        M.total_chars = M.total_chars - dropped.chars
    end
    rebuild_chunks()
end

function M.flush_pending()
    if M.pending and M.pending.chars > 0 then
        push_committed_text(M.pending.text, M.pending.ts)
    end
    M.pending = nil
end

function M.on_commit(text)
    if not text or #text == 0 then return end
    -- 先把上一条没被退格撤回的 pending 正式推进近期队列
    M.flush_pending()
    -- 必须至少包含 1 个汉字才入队
    local has_han = false
    local cnt = 0
    for _, code in utf8.codes(text) do
        cnt = cnt + 1
        if is_cjk_code(code) then
            has_han = true
        end
    end
    if has_han and cnt <= 40 then
        M.pending = { text = text, chars = cnt, ts = os.time() }
    end
end

function M.on_backspace()
    if not M.pending then return end
    if (os.time() - M.pending.ts) > 20 then
        M.flush_pending()
        return
    end
    -- 用户刚上屏就按了退格：从 pending 末尾删掉对应字数，若删光则整条作废
    local chars = utf8_chars(M.pending.text)
    if #chars <= 1 then
        M.pending = nil
    else
        table.remove(chars)
        M.pending.text = table.concat(chars)
        M.pending.chars = #chars
    end
end

-- 判断 keys 是否精确匹配某条音节列表（每字消费至少 1 个前缀字母）
local function match_sylls_exact(keys, sylls)
    local n_keys = #keys
    local n_sylls = #sylls
    if n_keys < n_sylls then return false end

    local function dfs(si, ki)
        if si > n_sylls then
            return ki == n_keys + 1
        end
        local rem_sylls = n_sylls - si + 1
        local rem_keys = n_keys - ki + 1
        if rem_keys < rem_sylls then return false end

        local sy = sylls[si]
        local max_take = math.min(#sy, rem_keys - (rem_sylls - 1))
        for take = max_take, 1, -1 do
            if keys:sub(ki, ki + take - 1) == sy:sub(1, take) then
                if dfs(si + 1, ki + take) then
                    return true
                end
            end
        end
        return false
    end

    return dfs(1, 1)
end

-- 轻度容错：当 keys >= 4 且精确没命中时，允许单个音节缺 1 个字母（如 yixa -> yixia）或邻换（changhs -> changsh）
local function match_sylls_fuzzy(keys, sylls)
    local n_keys = #keys
    local n_sylls = #sylls
    if n_keys < n_sylls then return false end

    local function dfs(si, ki, used_typo)
        if si > n_sylls then
            return ki == n_keys + 1
        end
        local rem_sylls = n_sylls - si + 1
        local rem_keys = n_keys - ki + 1
        if rem_keys < rem_sylls then return false end

        local sy = sylls[si]
        -- 正常前缀匹配
        local max_take = math.min(#sy, rem_keys - (rem_sylls - 1))
        for take = max_take, 1, -1 do
            if keys:sub(ki, ki + take - 1) == sy:sub(1, take) then
                if dfs(si + 1, ki + take, used_typo) then
                    return true
                end
            end
        end

        if not used_typo and #sy >= 3 then
            -- 尝试缺 1 个内部字母的全音节匹配 (如 xi->x 跳, xia->xa, yixia->yixa)
            for drop = 2, #sy do
                local v = sy:sub(1, drop - 1) .. sy:sub(drop + 1)
                if #v >= 2 and rem_keys >= #v and keys:sub(ki, ki + #v - 1) == v then
                    if dfs(si + 1, ki + #v, true) then
                        return true
                    end
                end
            end
            -- 尝试相邻两字母换序 (如 kuai -> kaui)
            for sw = 1, #sy - 1 do
                local v = sy:sub(1, sw - 1) .. sy:sub(sw + 1, sw + 1) .. sy:sub(sw, sw) .. sy:sub(sw + 2)
                if rem_keys >= #v and keys:sub(ki, ki + #v - 1) == v then
                    if dfs(si + 1, ki + #v, true) then
                        return true
                    end
                end
            end
        end
        return false
    end

    return dfs(1, 1, false)
end

-- 查询匹配近期队列的短语，返回按 (exact, len, seq) 排序的前若干候选文本
function M.query(raw_keys)
    if not raw_keys or #raw_keys < 2 then return {} end
    -- 把尚未落队的 pending（如果距离上屏已经超过 3 秒且没被删）也允许立刻参与查询，体验最连贯
    if M.pending and (os.time() - M.pending.ts) >= 3 then
        M.flush_pending()
    end

    local fi = raw_keys:sub(1, 1)
    local bucket = M.first_bucket[fi]
    if not bucket or #bucket == 0 then return {} end

    local hits = {}
    for _, rec in ipairs(bucket) do
        local matched = false
        local is_exact = false
        for _, sylls in ipairs(rec.sylls_list) do
            if match_sylls_exact(raw_keys, sylls) then
                matched = true
                is_exact = true
                break
            end
        end
        if not matched and #raw_keys >= 4 then
            for _, sylls in ipairs(rec.sylls_list) do
                if match_sylls_fuzzy(raw_keys, sylls) then
                    matched = true
                    break
                end
            end
        end
        if matched then
            hits[#hits + 1] = {
                phrase = rec.phrase,
                len = rec.len,
                seq = rec.seq,
                exact = is_exact and 1 or 0,
            }
        end
    end

    table.sort(hits, function(a, b)
        if a.exact ~= b.exact then return a.exact > b.exact end
        if a.len ~= b.len then return a.len > b.len end
        return a.seq > b.seq
    end)

    local out = {}
    for i = 1, math.min(#hits, 3) do
        out[i] = hits[i].phrase
    end
    return out
end

return M
