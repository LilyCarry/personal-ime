-- 规则自动切换轻量提醒 Filter（基于 rule_notify.txt，异常或文件缺失时零副作用静默放行）
local M = {}

local function get_notify_path()
    if not rime_api or not rime_api.get_user_data_dir then
        return nil
    end
    local sep = package.config:sub(1, 1)
    return rime_api:get_user_data_dir() .. sep .. "rule_notify.txt"
end

local function read_notify_state(path)
    if not path then
        return 0, nil
    end
    local ok, rem, msg = pcall(function()
        local f = io.open(path, "r")
        if not f then
            return 0, nil
        end
        local first_line = f:read("*l")
        local second_line = f:read("*l")
        f:close()
        local count = tonumber(first_line) or 0
        if count <= 0 or not second_line or #second_line == 0 then
            return 0, nil
        end
        return count, second_line
    end)
    if not ok then
        return 0, nil
    end
    return rem or 0, msg
end

local function write_notify_state(path, remaining, message)
    if not path then
        return
    end
    pcall(function()
        if remaining <= 0 or not message or #message == 0 then
            local f = io.open(path, "w")
            if f then
                f:write("0\n")
                f:close()
            end
            return
        end
        local f = io.open(path, "w")
        if f then
            f:write(tostring(remaining) .. "\n" .. message .. "\n")
            f:close()
        end
    end)
end

function M.init(env)
    env.notify_path = get_notify_path()
    local remaining, message = read_notify_state(env.notify_path)
    env.notify_remaining = remaining
    env.notify_banner = message

    if env.engine and env.engine.context and env.engine.context.commit_notifier then
        env.notify_commit_conn = env.engine.context.commit_notifier:connect(function(_ctx)
            if not env.notify_banner or env.notify_remaining <= 0 then
                return
            end
            env.notify_remaining = env.notify_remaining - 1
            write_notify_state(env.notify_path, env.notify_remaining, env.notify_banner)
            if env.notify_remaining <= 0 then
                env.notify_banner = nil
            end
        end)
    end
end

function M.fini(env)
    if env.notify_commit_conn then
        pcall(function()
            env.notify_commit_conn:disconnect()
        end)
        env.notify_commit_conn = nil
    end
end

function M.func(input, env)
    local banner = env.notify_banner
    if not banner or env.notify_remaining <= 0 then
        for cand in input:iter() do
            yield(cand)
        end
        return
    end

    local is_first = true
    for cand in input:iter() do
        if is_first then
            is_first = false
            pcall(function()
                local existing = cand.comment or ""
                if #existing > 0 then
                    cand.comment = existing .. " " .. banner
                else
                    cand.comment = banner
                end
            end)
        end
        yield(cand)
    end
end

return M
