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
--how often to poll the server while a book is open, so web edits show up without a manual sync.
--each tick is skipped instantly when offline, so it won't keep wifi awake on a real device.
local PERIODIC_SECONDS = 15

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

--poll the server every PERIODIC_SECONDS while the book is open, so changes made on the web (or
--another device) appear here without a manual sync. reschedules itself, stop with stopPeriodic.
function ContextSync:startPeriodic()
    if not self:isConfigured() then return end
    self:stopPeriodic()
    self._periodic = function()
        self._periodic = nil
        self:syncNow()
        self:startPeriodic() -- schedule the next tick (no-op if it got disabled meanwhile)
    end
    UIManager:scheduleIn(PERIODIC_SECONDS, self._periodic)
end

function ContextSync:stopPeriodic()
    if self._periodic then
        UIManager:unschedule(self._periodic)
        self._periodic = nil
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
    --stamp where the reader is up to so the webapp can jump its timeline there. computed fresh on each
    --push (including periodic ones) so it tracks reading, not just note edits. the merged result we adopt
    --carries it back, so the local file stays current too.
    local doc = self.store:load()
    local progress = self.store:describeLocator(nil).progress
    if progress then doc.reading_progress = progress end
    --push the active profile, passing its name so a freshly created one registers server-side
    local profile = self.store:getProfileId()
    local ok, merged = client:pushBook(book_id, doc, profile, self.store:getProfileName(profile))
    if ok and type(merged) == "table" and merged.contexts then
        self.store:replace(merged) -- adopt the merged result without re-triggering a sync
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("Synced.") })
        end
    elseif interactive then
        UIManager:show(InfoMessage:new{ text = T(_("Sync failed (%1)."), tostring(merged)) })
    end
end

--build the device's book catalog from its read history: { book_id, title, authors } for each book we
--can find a sync id (partial md5) for. lets the web ui offer to start contexts for books with no notes.
function ContextSync:buildLibrary()
    local ok, ReadHistory = pcall(require, "readhistory")
    if not ok or not ReadHistory or not ReadHistory.hist then return {} end
    local DocSettings = require("docsettings")
    local util = require("util")
    local out, seen = {}, {}
    for i = 1, #ReadHistory.hist do
        if #out >= 250 then break end --keep it bounded on big histories
        local file = ReadHistory.hist[i] and ReadHistory.hist[i].file
        if file then
            local okd, ds = pcall(function() return DocSettings:open(file) end)
            if okd and ds then
                local md5 = ds:readSetting("partial_md5_checksum")
                if md5 and not seen[md5] then
                    seen[md5] = true
                    local props = ds:readSetting("doc_props") or {}
                    local title = props.display_title or props.title
                    if not title or title == "" then
                        local _p, name = util.splitFilePathName(file)
                        title = name
                    end
                    out[#out + 1] = { book_id = md5, title = title or "", authors = props.authors or props.author or "" }
                end
            end
        end
    end
    return out
end

--push the read-history catalog to the server (best-effort, like the rest of sync)
function ContextSync:syncLibrary()
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end
    local books = self:buildLibrary()
    if #books == 0 then return end
    local s = self:settings()
    ContextSyncClient:new(s.server, s.username, s.password):pushLibrary(books)
end

--pull the book's profile list from the server and fold it into the local list, so profiles created on
--the web (or another device) show up in the picker here. server names win, local-only profiles not yet
--pushed are kept. best-effort like the rest of sync.
function ContextSync:syncProfiles()
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end
    local book_id = self.store:getBookId()
    if not book_id then return end
    local s = self:settings()
    local ok, list = ContextSyncClient:new(s.server, s.username, s.password):listProfiles(book_id)
    if not ok or type(list) ~= "table" then return end
    local by_id, order = {}, {}
    for _, p in ipairs(self.store:getProfileList()) do
        if not by_id[p.id] then by_id[p.id] = { id = p.id, name = p.name }; order[#order + 1] = p.id end
    end
    for _, p in ipairs(list) do
        local id = p.profile_id
        if id then
            if by_id[id] then by_id[id].name = p.name or by_id[id].name
            else by_id[id] = { id = id, name = p.name or id }; order[#order + 1] = id end
        end
    end
    local merged = {}
    for _, id in ipairs(order) do merged[#merged + 1] = by_id[id] end
    if #merged > 0 then self.store:setProfileList(merged) end
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
                    self:startPeriodic() -- begin polling without needing to reopen the book
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
