-- 个人输入法训练数据采集插件（脱敏 + 退格快照 + 删字重打关联 + 硬件连击检测）
-- 仅在内存记录当前组词会话，上屏时追加写入 user_logs/<device>_<YYYY-MM>.jsonl

local M = {}

-- 更换新键盘后可改为 "new_kb"（或在 rime_ice.custom.yaml 设置 ime_logger/hw_tag）
local DEFAULT_HW_TAG = "old_kb"
-- 同字母连续触发间隔低于此阈值（秒）视为机械抖动/连击
local CHATTER_THRESHOLD_SEC = 0.080

local function detect_device()
    if package.config:sub(1, 1) == "\\" then
        return "win"
    end
    return "android"
end

local function json_escape(str)
    if str == nil then return "" end
    str = tostring(str)
    str = str:gsub("\\", "\\\\")
    str = str:gsub('"', '\\"')
    str = str:gsub("\n", "\\n")
    str = str:gsub("\r", "\\r")
    str = str:gsub("\t", "\\t")
    str = str:gsub("[%z\1-\31]", function(c)
        return string.format("\\u%04x", string.byte(c))
    end)
    return str
end

local function json_str_array(arr)
    local parts = {}
    for i = 1, #arr do
        parts[i] = '"' .. json_escape(arr[i]) .. '"'
    end
    return "[" .. table.concat(parts, ",") .. "]"
end

local function has_cjk(text)
    if not text or #text == 0 then return false end
    for _, code in utf8.codes(text) do
        if code >= 0x4E00 and code <= 0x9FFF then
            return true
        end
    end
    return false
end

local function is_sensitive(text)
    if not text or #text == 0 then return false end
    -- 连续 4 位及以上数字（验证码/手机号/银行卡/学号等）
    if text:match("%d%d%d%d") then return true end
    -- 邮箱、链接、常见密钥前缀
    if text:find("@", 1, true) then return true end
    if text:find("://", 1, true) then return true end
    if text:match("sk%-[%w_-]+") or text:match("ghp_[%w]+") or text:match("AKIA[%w]+") then
        return true
    end
    return false
end

local function utf8_tail(text, max_chars)
    if not text or #text == 0 then return "" end
    local len = utf8.len(text)
    if not len or len <= max_chars then return text end
    local offset = utf8.offset(text, len - max_chars + 1)
    return offset and text:sub(offset) or text
end

local function utf8_drop_last(text)
    if not text or #text == 0 then return "" end
    local len = utf8.len(text)
    if not len or len <= 1 then return "" end
    local offset = utf8.offset(text, len)
    return offset and text:sub(1, offset - 1) or ""
end

local function snapshot_candidates(ctx, sess, preserve_idx)
    local comp = ctx.composition
    if not comp or comp:empty() then return end
    local seg = comp:back()
    if not seg or not seg.menu then return end
    local menu = seg.menu
    local count = menu:candidate_count()
    if count > 0 then
        local cands = {}
        local cand_map = {}
        local top_limit = math.min(count, 5)
        local map_limit = math.min(count, 25)
        for i = 0, map_limit - 1 do
            local cand = menu:get_candidate_at(i)
            if cand and cand.text then
                if i < top_limit then
                    table.insert(cands, cand.text)
                end
                if cand_map[cand.text] == nil then
                    cand_map[cand.text] = i
                end
            end
        end
        if #cands > 0 then
            sess.top_cands = cands
            sess.cand_index_map = cand_map
            sess.cand_count = map_limit
        end
    end
    if not preserve_idx and seg.selected_index and seg.selected_index > 0 then
        sess.selected_idx = seg.selected_index
    end
end

local function new_session(ctx)
    return {
        start_clock = os.clock(),
        raw_input = ctx.input or "",
        first_attempt = nil,
        backspaces = 0,
        page_turns = 0,
        select_count = 0,
        top_cands = {},
        cand_index_map = {},
        cand_count = 0,
        selected_idx = 0,
        had_ascii_enter = false,
        chatter = {},
        prev_letter = nil,
        prev_letter_clock = 0,
    }
end

function M.init(env)
    env.device = detect_device()
    env.log_dir = rime_api:get_user_data_dir() .. "/user_logs"
    local cfg_hw = env.engine and env.engine.schema and env.engine.schema.config
        and env.engine.schema.config:get_string("ime_logger/hw_tag")
    env.hw_tag = (cfg_hw and #cfg_hw > 0) and cfg_hw or DEFAULT_HW_TAG

    env.seq = 0
    env.last_commit_seq = 0
    env.last_commit_ts = 0
    env.post_commit_bs = 0
    env.trailing_punct_chars = 0
    env.prev_context = ""
    env.session = nil

    -- Android Scoped Storage 下：如果 shell 预建了 0666 的 *_pub.jsonl，则把已有日志同步一份过去方便 ADB 拉取
    if env.device == "android" then
        pcall(function()
            local month_str = os.date("%Y-%m")
            local priv_path = string.format("%s/android_%s.jsonl", env.log_dir, month_str)
            local pub_path = string.format("%s/android_%s_pub.jsonl", env.log_dir, month_str)
            local fp_check = io.open(pub_path, "r")
            if fp_check then
                local pub_size = fp_check:seek("end") or 0
                fp_check:close()
                if pub_size == 0 then
                    local f_priv = io.open(priv_path, "r")
                    if f_priv then
                        local content = f_priv:read("*a")
                        f_priv:close()
                        if content and #content > 0 then
                            local f_pub = io.open(pub_path, "a")
                            if f_pub then
                                f_pub:write(content)
                                f_pub:close()
                            end
                        end
                    end
                end
            end
        end)
    end

    env.update_notifier = env.engine.context.update_notifier:connect(function(ctx)
        pcall(function()
            if ctx:get_option("ascii_mode") or not ctx:is_composing() then return end
            if not env.session then env.session = new_session(ctx) end
            env.session.raw_input = ctx.input or env.session.raw_input
            -- 仅在未分段或当前仍在组词时刷新真实候选列表（包含最后一个字母上屏前的状态）
            snapshot_candidates(ctx, env.session, true)
        end)
    end)

    env.select_notifier = env.engine.context.select_notifier:connect(function(ctx)
        pcall(function()
            if not env.session then env.session = new_session(ctx) end
            env.session.select_count = env.session.select_count + 1
            local comp = ctx.composition
            if comp and not comp:empty() then
                local seg = comp:back()
                if seg and seg.selected_index and seg.selected_index > 0 then
                    env.session.selected_idx = seg.selected_index
                end
            end
        end)
    end)

    env.commit_notifier = env.engine.context.commit_notifier:connect(function(ctx)
        pcall(function()
            local now = os.time()
            local committed = ctx:get_commit_text() or ""
            local sess = env.session
            env.session = nil

            if ctx:get_option("ascii_mode") then
                env.prev_context = ""
                env.trailing_punct_chars = 0
                env.post_commit_bs = 0
                return
            end
            if #committed == 0 then return end

            -- 超过 60 秒无连续输入则清空上文窗口，避免跨场景串联
            if env.last_commit_ts > 0 and (now - env.last_commit_ts) > 60 then
                env.prev_context = ""
                env.trailing_punct_chars = 0
                env.post_commit_bs = 0
            end

            local raw_input = (sess and sess.raw_input) or ""
            if #raw_input == 0 or not has_cjk(committed) then
                -- 纯标点或短字符：记入尾部标点计数，避免删掉句号后误触发 replaces_seq
                if #committed <= 4 and not is_sensitive(committed) then
                    local char_len = utf8.len(committed) or 1
                    env.trailing_punct_chars = env.trailing_punct_chars + char_len
                    env.prev_context = utf8_tail(env.prev_context .. committed, 30)
                    env.last_commit_ts = now
                end
                return
            end

            if is_sensitive(committed) or is_sensitive(raw_input) then
                env.prev_context = ""
                env.trailing_punct_chars = 0
                env.post_commit_bs = 0
                return
            end

            env.seq = env.seq + 1
            local replaces_seq = nil
            local post_bs = 0
            if env.post_commit_bs > 0 and env.last_commit_seq > 0 and (now - env.last_commit_ts) <= 20 then
                replaces_seq = env.last_commit_seq
                post_bs = env.post_commit_bs
            end

            local duration_ms = sess and math.floor((os.clock() - sess.start_clock) * 1000) or 0
            local first_attempt = (sess and sess.first_attempt) or raw_input
            local backspaces = (sess and sess.backspaces) or 0
            local page_turns = (sess and sess.page_turns) or 0
            local top_cands = (sess and sess.top_cands) or {}
            local selected_idx = (sess and sess.selected_idx) or 0
            local commit_type = (sess and sess.had_ascii_enter) and "enter" or "normal"
            local segmented = (sess and sess.select_count > 1) or false
            -- 触屏点选或未通过数字键上屏时，直接用最终上屏词反查真实候选序号
            if commit_type ~= "enter" and not segmented and sess and sess.cand_index_map then
                local matched = sess.cand_index_map[committed]
                if matched ~= nil then
                    selected_idx = matched
                elseif selected_idx == 0 and (sess.cand_count or 0) > 0 then
                    selected_idx = sess.cand_count
                end
            end
            local chatter = (sess and sess.chatter) or {}
            local schema_id = env.engine.schema and env.engine.schema.schema_id or "unknown"

            local parts = {
                '"ts":' .. tostring(now),
                '"seq":' .. tostring(env.seq),
                '"device":"' .. json_escape(env.device) .. '"',
                '"hw_tag":"' .. json_escape(env.hw_tag) .. '"',
                '"schema":"' .. json_escape(schema_id) .. '"',
                '"raw_input":"' .. json_escape(raw_input) .. '"',
                '"first_attempt":"' .. json_escape(first_attempt) .. '"',
                '"committed":"' .. json_escape(committed) .. '"',
                '"prev_context":"' .. json_escape(env.prev_context) .. '"',
                '"top_cands":' .. json_str_array(top_cands),
                '"selected_idx":' .. tostring(selected_idx),
                '"page_turns":' .. tostring(page_turns),
                '"backspaces":' .. tostring(backspaces),
                '"duration_ms":' .. tostring(duration_ms),
                '"commit_type":"' .. commit_type .. '"',
            }
            if segmented then
                table.insert(parts, '"segmented":true')
            end
            if #chatter > 0 then
                table.insert(parts, '"chatter":' .. json_str_array(chatter))
            end
            if replaces_seq then
                table.insert(parts, '"replaces_seq":' .. tostring(replaces_seq))
                table.insert(parts, '"post_commit_bs":' .. tostring(post_bs))
            end

            local line = "{" .. table.concat(parts, ",") .. "}\n"
            local month_str = os.date("%Y-%m", now)
            local filepath = string.format("%s/%s_%s.jsonl", env.log_dir, env.device, month_str)
            local f = io.open(filepath, "a")
            if f then
                f:write(line)
                f:close()
            end
            if env.device == "android" then
                local pub_path = string.format("%s/android_%s_pub.jsonl", env.log_dir, month_str)
                local fp = io.open(pub_path, "r")
                if fp then
                    fp:close()
                    local f_pub = io.open(pub_path, "a")
                    if f_pub then
                        f_pub:write(line)
                        f_pub:close()
                    end
                end
            end

            env.last_commit_seq = env.seq
            env.last_commit_ts = now
            env.post_commit_bs = 0
            env.trailing_punct_chars = 0
            env.prev_context = utf8_tail(env.prev_context .. committed, 30)
        end)
    end)
end

function M.func(key, env)
    if key:release() then return 2 end
    pcall(function()
        local ctx = env.engine.context
        local repr = key:repr()

        if ctx:get_option("ascii_mode") then
            if repr == "Return" or repr == "KP_Enter" or repr == "Escape" then
                env.prev_context = ""
                env.post_commit_bs = 0
                env.trailing_punct_chars = 0
            end
            return
        end

        if ctx:is_composing() then
            if not env.session then
                env.session = new_session(ctx)
            end
            local sess = env.session
            sess.raw_input = ctx.input or sess.raw_input

            -- 检测极短间隔同键连击（硬件抖动/连打）
            if #repr == 1 and repr:match("^[a-z]$") then
                local now_clk = os.clock()
                if sess.prev_letter == repr then
                    local dt = now_clk - sess.prev_letter_clock
                    if dt >= 0 and dt < CHATTER_THRESHOLD_SEC then
                        table.insert(sess.chatter, string.format("%s:%dms", repr, math.floor(dt * 1000)))
                    end
                end
                sess.prev_letter = repr
                sess.prev_letter_clock = now_clk
            else
                sess.prev_letter = nil
            end

            if repr == "BackSpace" then
                if not sess.first_attempt and ctx.input and #ctx.input > 0 then
                    sess.first_attempt = ctx.input
                end
                sess.backspaces = sess.backspaces + 1
            elseif repr == "Page_Down" or repr == "Page_Up" or repr == "equal" or repr == "minus" then
                sess.page_turns = sess.page_turns + 1
            elseif repr == "Return" or repr == "KP_Enter" then
                sess.had_ascii_enter = true
            end

            snapshot_candidates(ctx, sess, true)

            local digit = repr:match("^([1-9])$")
            if digit then
                local comp = ctx.composition
                if comp and not comp:empty() then
                    local seg = comp:back()
                    if seg and seg.selected_index then
                        local page_size = env.engine.schema.page_size or 5
                        local page = math.floor(seg.selected_index / page_size)
                        sess.selected_idx = page * page_size + (tonumber(digit) - 1)
                    end
                end
            end
        else
            -- 非组词状态下的退格：先扣除末尾刚打上的标点，剩余的才算删掉中文词重打
            if repr == "BackSpace" then
                if env.last_commit_seq > 0 and (os.time() - env.last_commit_ts) <= 20 then
                    if env.trailing_punct_chars > 0 then
                        env.trailing_punct_chars = env.trailing_punct_chars - 1
                    else
                        env.post_commit_bs = env.post_commit_bs + 1
                    end
                    env.prev_context = utf8_drop_last(env.prev_context)
                end
            elseif repr == "Return" or repr == "KP_Enter" or repr == "Escape" or repr == "Tab" then
                env.prev_context = ""
                env.post_commit_bs = 0
                env.trailing_punct_chars = 0
            end
        end
    end)
    return 2
end

function M.fini(env)
    if env.update_notifier then
        env.update_notifier:disconnect()
    end
    if env.commit_notifier then
        env.commit_notifier:disconnect()
    end
    if env.select_notifier then
        env.select_notifier:disconnect()
    end
end

return M
