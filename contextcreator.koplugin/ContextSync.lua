--[[
seamless sync: push the local book doc to the server, which additively merges and returns the
merged result, which we adopt back locally. that one push-and-adopt covers both directions.

triggered debounced after every change (via the store's on_change), on book open, and flushed on
close. fully best-effort: if it's not configured or there's no network it just no-ops, the local
json stays the source of truth, and it retries on the next trigger. settings live in
G_reader_settings under "contextcreator_sync" = { enabled, server, username, password }; the plugin
authenticates with the same account credentials as the web app (HTTP Basic auth).
]]

local InfoMessage = require("ui/widget/infomessage")
local MultiInputDialog = require("ui/widget/multiinputdialog")
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
    return s.enabled == true and s.server and s.server ~= ""
        and s.username and s.username ~= "" and s.password and s.password ~= ""
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
            UIManager:show(InfoMessage:new{ text = _("Sync isn't set up. Set the server URL, username and password first.") })
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
    local client = ContextSyncClient:new(s.server, s.username, s.password)
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
--one login window: server URL + username + password together (password masked, kept if left blank).
--saving logs in (enables sync) and does an immediate sync so the user gets instant feedback.
function ContextSync:showLogin(touchmenu)
    local s = self:settings()
    local dialog
    dialog = MultiInputDialog:new{
        title = _("Context Creator sync"),
        fields = {
            { text = s.server or "", hint = _("server URL, e.g. http://192.168.1.50:8791") },
            { text = s.username or "", hint = _("username") },
            { text = "", hint = (s.password and s.password ~= "") and _("password (leave blank to keep)") or _("password"), text_type = "password" },
        },
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Log in"),
                callback = function()
                    local server, username, password = unpack(dialog:getFields())
                    local ns = self:settings()
                    ns.server = (server or ""):gsub("^%s+", ""):gsub("%s+$", ""):gsub("/+$", "")
                    ns.username = (username or ""):gsub("^%s+", ""):gsub("%s+$", "")
                    if password and password ~= "" then ns.password = password end
                    ns.enabled = true -- logging in turns sync on
                    self:saveSettings(ns)
                    UIManager:close(dialog)
                    if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                    UIManager:scheduleIn(0.3, function() self:syncNow(true) end) -- test the credentials
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
                if s.server and s.server ~= "" and s.username and s.username ~= "" then
                    return T(_("Logged in: %1 @ %2"), s.username, s.server)
                end
                return _("Log in\u{2026}")
            end,
            keep_menu_open = true,
            callback = function(touchmenu) self:showLogin(touchmenu) end,
        },
        {
            text = _("Sync now"),
            keep_menu_open = true,
            callback = function() self:syncNow(true) end,
        },
    }
end

return ContextSync
