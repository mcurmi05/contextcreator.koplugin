--[[
seamless sync: push the local book doc to the server, which additively merges and returns the
merged result, which we adopt back locally. that one push-and-adopt covers both directions.

triggered debounced after every change (via the store's on_change), on book open, and flushed on
close. fully best-effort: if it's not configured or there's no network it just no-ops, the local
json stays the source of truth, and it retries on the next trigger. settings live in
G_reader_settings under "contextcreator_sync" = { enabled, server, token }.
]]

local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local _ = require("gettext")
local T = require("ffi/util").template
local ContextSyncClient = require("ContextSyncClient")

--how long after the last change before we actually push (coalesces a burst of edits into one sync)
local DEBOUNCE_SECONDS = 2

local ContextSync = {}
ContextSync.__index = ContextSync

function ContextSync:new(store)
    return setmetatable({ store = store }, ContextSync)
end

function ContextSync:settings()
    return G_reader_settings:readSetting("contextcreator_sync") or {}
end

function ContextSync:saveSettings(s)
    G_reader_settings:saveSetting("contextcreator_sync", s)
end

function ContextSync:isConfigured()
    local s = self:settings()
    return s.enabled == true and s.server and s.server ~= "" and s.token and s.token ~= ""
end

--schedule a push DEBOUNCE_SECONDS after the latest change, replacing any pending one (trailing debounce)
function ContextSync:scheduleSync()
    if not self:isConfigured() then return end
    if self._pending then UIManager:unschedule(self._pending) end
    self._pending = function()
        self._pending = nil
        self:syncNow()
    end
    UIManager:scheduleIn(DEBOUNCE_SECONDS, self._pending)
end

--flush a pending debounced push immediately (used on book close so changes don't wait)
function ContextSync:flush()
    if self._pending then
        UIManager:unschedule(self._pending)
        self._pending = nil
        self:syncNow()
    end
end

--push local -> server merge -> adopt merged. interactive=true shows feedback (for the manual "Sync now").
function ContextSync:syncNow(interactive)
    if not self:isConfigured() then
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("Sync isn't set up. Set the server URL and device token first.") })
        end
        return
    end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("No network connection.") })
        end
        return -- silently retry on the next trigger
    end
    local book_id = self.store:getBookId()
    if not book_id then
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("This book has no sync id, so it can't be synced.") })
        end
        return
    end

    local s = self:settings()
    local client = ContextSyncClient:new(s.server, s.token)
    local ok, merged = client:pushBook(book_id, self.store:load())
    if ok and type(merged) == "table" and merged.contexts then
        self.store:replace(merged) -- adopt the merged result without re-triggering a sync
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("Synced.") })
        end
    elseif interactive then
        UIManager:show(InfoMessage:new{ text = T(_("Sync failed (%1)."), tostring(merged)) })
    end
end

--a single text setting (server url / token), edited through an input dialog
function ContextSync:editSetting(field, title, hint)
    local s = self:settings()
    local dialog
    dialog = InputDialog:new{
        title = title,
        input = s[field] or "",
        input_hint = hint,
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Save"),
                is_enter_default = true,
                callback = function()
                    local v = (dialog:getInputText() or ""):gsub("^%s+", ""):gsub("%s+$", "")
                    s[field] = v
                    self:saveSettings(s)
                    UIManager:close(dialog)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--the "Sync" submenu shown under Context Creator in the reader menu
function ContextSync:menu()
    return {
        {
            text = _("Enable sync"),
            checked_func = function() return self:settings().enabled == true end,
            callback = function()
                local s = self:settings()
                s.enabled = not s.enabled
                self:saveSettings(s)
            end,
        },
        {
            text_func = function()
                local s = self:settings()
                return T(_("Server URL: %1"), (s.server and s.server ~= "") and s.server or _("not set"))
            end,
            keep_menu_open = true,
            callback = function() self:editSetting("server", _("Server URL"), _("e.g. http://192.168.1.50:8791")) end,
        },
        {
            text_func = function()
                local s = self:settings()
                return (s.token and s.token ~= "") and _("Device token: set") or _("Device token: not set")
            end,
            keep_menu_open = true,
            callback = function() self:editSetting("token", _("Device token"), _("paste the token from the web app")) end,
        },
        {
            text = _("Sync now"),
            keep_menu_open = true,
            callback = function() self:syncNow(true) end,
        },
    }
end

return ContextSync
