-- 配合 recent_store 维护最近 200 字队列（处理上屏入队与退格撤回）
local store = require("recent_store")

local M = {}

function M.init(env)
    env.rc_commit_notifier = env.engine.context.commit_notifier:connect(function(ctx)
        pcall(function()
            if ctx:get_option("ascii_mode") then
                store.flush_pending()
                return
            end
            local text = ctx:get_commit_text() or ""
            if #text > 0 then
                store.on_commit(text)
            end
        end)
    end)
end

function M.func(key, env)
    if key:release() then return 2 end
    pcall(function()
        local ctx = env.engine.context
        if not ctx:is_composing() then
            local repr = key:repr()
            if repr == "BackSpace" then
                store.on_backspace()
            elseif repr == "Return" or repr == "KP_Enter" or repr == "Escape" then
                store.flush_pending()
            end
        end
    end)
    return 2
end

function M.fini(env)
    if env.rc_commit_notifier then
        env.rc_commit_notifier:disconnect()
    end
end

return M
