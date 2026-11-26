-- 本地 AI 候选注入 Filter（通过 ime_bridge.dll 零黑框直连本地 GPU 服务）
-- 仅在输入 >= 3 个纯字母时查询，服务未启动时 0.1ms 直接回退原生雾凇

local M = {}

local bridge = nil

local function load_bridge()
    if bridge then return bridge end
    local dll_path = rime_api:get_user_data_dir() .. "\\lua\\ime_bridge.dll"
    local loader, err = package.loadlib(dll_path, "luaopen_ime_bridge")
    if loader then
        bridge = loader()
    end
    return bridge
end

local function json_escape(str)
    if not str then return "" end
    str = tostring(str)
    str = str:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
    return str
end

-- 从 {"cands":["一下","一些"]} 解析字符串数组
local function parse_cands(json_str)
    if not json_str or #json_str == 0 then return {} end
    local arr_body = json_str:match('"cands"%s*:%s*%[(.-)%]')
    if not arr_body or #arr_body == 0 then return {} end
    local res = {}
    for item in arr_body:gmatch('"(.-)"') do
        -- 还原简单转义
        local s = item:gsub('\\"', '"'):gsub('\\\\', '\\')
        if #s > 0 then
            table.insert(res, s)
        end
    end
    return res
end

local function utf8_tail(text, max_chars)
    if not text or #text == 0 then return "" end
    local len = utf8.len(text)
    if not len or len <= max_chars then return text end
    local offset = utf8.offset(text, len - max_chars + 1)
    return offset and text:sub(offset) or text
end

function M.init(env)
    load_bridge()
    env.ai_prev_context = ""
    env.ai_last_ts = 0
    env.cache_key = nil
    env.cache_cands = {}

    env.ai_commit_notifier = env.engine.context.commit_notifier:connect(function(ctx)
        pcall(function()
            local now = os.time()
            local committed = ctx:get_commit_text() or ""
            if env.ai_last_ts > 0 and (now - env.ai_last_ts) > 60 then
                env.ai_prev_context = ""
            end
            if ctx:get_option("ascii_mode") then
                env.ai_prev_context = ""
                return
            end
            if #committed > 0 then
                env.ai_prev_context = utf8_tail(env.ai_prev_context .. committed, 28)
                env.ai_last_ts = now
            end
            env.cache_key = nil
        end)
    end)
end

function M.func(input, env)
    local ctx = env.engine.context
    local raw = ctx.input or ""
    local comp = ctx.composition
    local seg = (comp and not comp:empty()) and comp:back() or nil
    local start_pos = seg and seg.start or 0
    local end_pos = seg and seg._end or #raw
    local seg_keys = raw:sub(start_pos + 1, end_pos)
    local ai_cands = {}

    -- 仅在输入末尾敲入单引号 ' 时触发一次本地 AI（如 yixa' / wmxqcf'），平时打字 0ms 零阻塞
    local tail_keys = raw:sub(start_pos + 1)
    local clean_keys = tail_keys:match("^([a-z]+)'$")
    if bridge and clean_keys and not ctx:get_option("ascii_mode") and #clean_keys >= 2 and #clean_keys <= 32 then
        end_pos = #raw
        local now = os.time()
        local prev_ctx = (env.ai_last_ts > 0 and (now - env.ai_last_ts) <= 60) and env.ai_prev_context or ""
        local ck = prev_ctx .. "\t" .. clean_keys
        if env.cache_key == ck then
            ai_cands = env.cache_cands
        else
            local payload = string.format('{"ctx":"%s","keys":"%s"}', json_escape(prev_ctx), clean_keys)
            local ok, resp = pcall(bridge.query, "127.0.0.1", 18765, payload, 700)
            if ok and resp then
                ai_cands = parse_cands(resp)
            else
                ai_cands = {}
            end
            env.cache_key = ck
            env.cache_cands = ai_cands
        end
    end

    if #ai_cands == 0 then
        for cand in input:iter() do
            yield(cand)
        end
        return
    end

    -- 收集原雾凇前若干候选，把 AI 首选置顶（带 [AI] 标注），同时保留原生候选且去重
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

    -- 先输出 AI Top-1
    local ai1 = ai_cands[1]
    if ai1 and #ai1 > 0 then
        local c = Candidate("ai", start_pos, end_pos, ai1, "[AI]")
        c.quality = 100
        yield(c)
        seen[ai1] = true
    end

    -- 再输出原雾凇 Top-1（如与 AI Top-1 不重）
    if #rime_cands >= 1 and not seen[rime_cands[1].text] then
        seen[rime_cands[1].text] = true
        yield(rime_cands[1])
    end

    -- 插入 AI Top-2（若有且不重）
    if #ai_cands >= 2 and not seen[ai_cands[2]] then
        local c2 = Candidate("ai", start_pos, end_pos, ai_cands[2], "[AI]")
        c2.quality = 90
        yield(c2)
        seen[ai_cands[2]] = true
    end

    -- 输出其余雾凇候选
    for i = 2, #rime_cands do
        local rc = rime_cands[i]
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

function M.fini(env)
    if env.ai_commit_notifier then
        env.ai_commit_notifier:disconnect()
    end
end

return M
