--[[
seamless sync: push the local book doc to the server, which additively merges and returns the
merged result, which we adopt back locally. that one push-and-adopt covers both directions.

triggered debounced after every change (via the store's on_change), on book open, and flushed on
close. fully best-effort: if it's not configured or there's no network it just no-ops, the local
json stays the source of truth, and it retries on the next trigger. settings live in
G_reader_settings under "contextcreator_sync" = { enabled, server, username, password }; the plugin
authenticates with the same account credentials as the web app (HTTP Basic auth).
]]

local ConfirmBox = require("ui/widget/confirmbox")
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
--gap between cover-extraction batches when draining the backlog (see syncLibrary). small batches keep
--each pass non-blocking; chaining them fills a whole library within a minute of one app start.
local COVER_DRAIN_SECONDS = 4

--koreader/calibre series_index is 1-based and may be fractional; the web groups by 0-based integer order.
local function webSeriesIndex(n)
    n = tonumber(n)
    if not n then return 0 end
    return math.max(0, math.floor(n + 0.5) - 1)
end

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

--a stable id + friendly name for this device, so the web's "jump to current" can tell devices apart.
--the id is minted once and persisted in our sync settings; the name defaults to the koreader model.
function ContextSync:deviceInfo()
    local s = self:settings()
    if not s.device_id or s.device_id == "" then
        --build the id from 16-bit chunks: %04x on a value < 65536 is safe on every lua build, whereas
        --formatting a full 32-bit random with %x crashes LuaJIT (kobo) for values past 2^31.
        math.randomseed(os.time() + math.floor((os.clock() or 0) * 1000))
        local function chunk() return string.format("%04x", math.random(0, 0xffff)) end
        s.device_id = "dev-" .. chunk() .. chunk() .. chunk() .. chunk()
        self:saveSettings(s)
    end
    local name = s.device_name
    if not name or name == "" then
        local ok, Device = pcall(require, "device")
        name = (ok and Device and Device.model) or "KOReader"
    end
    return { id = s.device_id, name = name }
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

--a 401 means the stored credentials no longer work (typically the password was changed on the web).
--stop the periodic retries so we don't hammer the server, and prompt to log back in. guarded so the
--background polling can't spam the prompt: it fires once, then stays quiet until a login is attempted.
function ContextSync:authFailed()
    if self._auth_prompted then return end
    self._auth_prompted = true
    self:stopPeriodic()
    UIManager:show(ConfirmBox:new{
        text = _("Context Creator sync was rejected — your saved password no longer works (it may have been changed on the web). Log in again?"),
        ok_text = _("Log in"),
        ok_callback = function() self:showLogin() end,
    })
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
    local loc = self.store:describeLocator(nil)
    if loc.progress then doc.reading_progress = loc.progress end
    --push the active profile, passing its name so a freshly created one registers server-side, and this
    --device's id/name + current chapter so the server records this device's position separately from
    --other devices' (the chapter lets the webapp re-anchor it correctly onto a shared, cross-device timeline)
    local dev = self:deviceInfo()
    dev.chapter = loc.chapter
    dev.chapter_frac = loc.chapter_frac
    local profile = self.store:getProfileId()
    local ok, merged = client:pushBook(book_id, doc, profile, self.store:getProfileName(profile), dev)
    if ok and type(merged) == "table" and merged.contexts then
        self._auth_prompted = false -- the credentials clearly work, re-arm the 401 prompt for next time
        self.store:replace(merged) -- adopt the merged result without re-triggering a sync
        if interactive then
            UIManager:show(InfoMessage:new{ text = _("Synced.") })
        end
    elseif merged == 401 then
        self:authFailed() -- stale password: prompt to log back in (shown for background syncs too)
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
                    out[#out + 1] = { book_id = md5, title = title or "", authors = props.authors or props.author or "",
                                      series = props.series or "", series_index = webSeriesIndex(props.series_index), file = file }
                end
            end
        end
    end
    return out
end

--book_ids we've already tried to extract (cover + metadata) from, so we never re-open a document twice
--(it's heavy). a book is recorded whether or not anything was found, so empty ones aren't reopened every
--sync. the set is stamped with EXTRACT_SCHEMA: when what we pull out of a book changes (e.g. we started
--reading metadata too, not just the cover), bumping the schema invalidates old marks so every book gets
--re-extracted once on upgrade instead of being stuck with whatever the old code produced.
local EXTRACT_SCHEMA = 2
function ContextSync:coversTried()
    local store = G_reader_settings:readSetting("contextcreator_covers_tried")
    if type(store) ~= "table" or store._schema ~= EXTRACT_SCHEMA then
        return { _schema = EXTRACT_SCHEMA } --old/missing: start fresh so the new extraction runs for all
    end
    return store
end

function ContextSync:markCoversTried(ids)
    local tried = self:coversTried()
    for _, id in ipairs(ids) do tried[id] = true end
    G_reader_settings:saveSetting("contextcreator_covers_tried", tried)
end

--forget a book so its cover/metadata gets re-read next push (used when koreader says it just changed)
function ContextSync:forgetCoverTried(id)
    local tried = self:coversTried()
    if tried[id] then
        tried[id] = nil
        G_reader_settings:saveSetting("contextcreator_covers_tried", tried)
    end
end

--open a book once and pull both its real metadata (title/authors/series) and a small jpeg cover thumbnail
--(as a data: url). returns a table { title?, authors?, series?, series_index?, cover? } or nil. opening a
--document is heavy, so callers bound how many they do per sync. this is what lets unopened books get their
--proper title/series the first time, instead of the filename. best-effort: any failure just yields nil.
local COVER_W, COVER_H = 120, 180
function ContextSync:extractBookInfo(file)
    local ok, info = pcall(function()
        local DocumentRegistry = require("document/documentregistry")
        if not DocumentRegistry:hasProvider(file) then return nil end --skip non-books fast
        local doc = DocumentRegistry:openDocument(file)
        if not doc then return nil end
        if doc.loadDocument then doc:loadDocument(false) end --crengine: load metadata only, not the whole book
        local BookInfo = require("apps/filemanager/filemanagerbookinfo")
        local props = BookInfo.extendProps(doc:getProps(), file) or {} --display_title falls back to filename
        local result = {
            title = props.display_title or props.title,
            authors = props.authors or props.author,
            series = props.series,
            series_index = webSeriesIndex(props.series_index),
        }
        local bb = BookInfo:getCoverImage(doc) --reuse the already-open document
        local scaled
        if bb then
            local RenderImage = require("ui/renderimage")
            local w, h = bb:getWidth(), bb:getHeight()
            local scale = math.min(COVER_W / w, COVER_H / h, 1)
            local nw = math.max(1, math.floor(w * scale))
            local nh = math.max(1, math.floor(h * scale))
            scaled = RenderImage:scaleBlitBuffer(bb, nw, nh, true) --frees the original bb
        end
        doc:close() --done with the document; the scaled buffer is independent memory
        if scaled then
            local DataStorage = require("datastorage")
            local tmp = DataStorage:getDataDir() .. "/cc_cover_tmp.jpg"
            local wrote = scaled:writeToFile(tmp, "jpg", 80)
            scaled:free()
            if wrote then
                local f = io.open(tmp, "rb")
                if f then
                    local data = f:read("*a")
                    f:close()
                    os.remove(tmp)
                    if data and data ~= "" then
                        local mime = require("mime")
                        result.cover = "data:image/jpeg;base64," .. (mime.b64(data))
                    end
                end
            end
        end
        return result
    end)
    return ok and info or nil
end

--scan the whole book folder (not just read history) so books you haven't opened yet still show up on the
--web. heavier than buildLibrary: walks the tree and hashes each file. the id is the same partial md5
--koreader stores, so a book keeps its identity once it's actually opened. returns { book_id, title,
--authors, file } per book. metadata comes from the sidecar when the book's been opened before, otherwise
--falls back to the filename (it'll fill in once opened/read-history-synced).
function ContextSync:buildLibraryAll()
    local util = require("util")
    local DocumentRegistry = require("document/documentregistry")
    local DocSettings = require("docsettings")
    --where the user's books live: their set home folder, else the last folder they browsed, else the
    --device's default books dir. same resolution koreader's own file manager uses.
    local home = G_reader_settings:readSetting("home_dir")
    if not home or home == "" then home = G_reader_settings:readSetting("lastdir") end
    if not home or home == "" then
        local okf, fmutil = pcall(require, "apps/filemanager/filemanagerutil")
        if okf and fmutil and fmutil.getDefaultDir then home = fmutil.getDefaultDir() end
    end
    if not home or home == "" then return {} end
    local out, seen = {}, {}
    util.findFiles(home, function(path)
        if #out >= 500 then return end --keep it bounded on big libraries
        if not DocumentRegistry:hasProvider(path) then return end --skip non-books
        local md5 = util.partialMD5(path)
        if not md5 or seen[md5] then return end
        seen[md5] = true
        local title, authors, series, series_index
        if DocSettings:hasSidecarFile(path) then --book's been opened: reuse its real metadata cheaply
            local okd, ds = pcall(function() return DocSettings:open(path) end)
            if okd and ds then
                local props = ds:readSetting("doc_props") or {}
                title = props.display_title or props.title
                authors = props.authors or props.author
                series = props.series
                series_index = props.series_index
            end
        end
        --no sidecar (book never opened) means no metadata here; title/authors/series get filled in from the
        --document itself when its cover is extracted (see extractBookInfo / _pushCatalog), so it's correct
        --without the user having to open the book first.
        if not title or title == "" then
            local _p, name = util.splitFilePathName(path)
            title = name
        end
        out[#out + 1] = { book_id = md5, title = title or "", authors = authors or "",
                          series = series or "", series_index = webSeriesIndex(series_index), file = path }
    end, true, 5000) --recursive, bound the walk so a huge tree can't run away
    return out
end

--push a book catalog to the server (best-effort, like the rest of sync). first-seen books also get their
--cover extracted and sent; a per-run budget keeps any single push from opening many documents, and the
--leftover backlog is drained in small batches (reusing this same in-memory list, so no re-scan/re-hash).
--once a book's cover has been tried the catalog stays light: just title/authors, no cover bytes re-sent.
function ContextSync:_pushCatalog(books)
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end --drain resumes later
    if #books == 0 then return end
    local tried = self:coversTried()
    local budget = 6 --opening documents is heavy; only extract a few new covers per run
    local fresh = {} --book_ids attempted this run, marked tried once the push lands
    local remaining = 0 --untried books we didn't get to this run (drives the drain reschedule below)
    local payload = {}
    for _, b in ipairs(books) do
        local item = { book_id = b.book_id, title = b.title, authors = b.authors,
                       series = b.series, series_index = b.series_index }
        if b.file and not tried[b.book_id] then
            if budget > 0 then
                budget = budget - 1
                local info = self:extractBookInfo(b.file)
                if info then
                    --the document's own metadata is authoritative; fill in anything we only had a filename
                    --for, and write it back onto the list entry so later drain pushes keep it (not the filename).
                    if info.cover then item.cover = info.cover end
                    if info.title and info.title ~= "" then item.title = info.title; b.title = info.title end
                    if info.authors and info.authors ~= "" then item.authors = info.authors; b.authors = info.authors end
                    if info.series and info.series ~= "" then
                        item.series = info.series; item.series_index = info.series_index
                        b.series = info.series; b.series_index = info.series_index
                    end
                end
                fresh[#fresh + 1] = b.book_id --attempted (cover or not), so we don't reopen it next time
            else
                remaining = remaining + 1
            end
        end
        payload[#payload + 1] = item
    end
    local s = self:settings()
    local ok, resp = ContextSyncClient:new(s.server, s.username, s.password):pushLibrary(payload)
    if not ok and resp == 401 then self:authFailed() end
    if ok and #fresh > 0 then self:markCoversTried(fresh) end
    --keep draining the cover backlog in small batches instead of waiting for the next app start, so a
    --whole library fills within a minute or so. only chains while there's more to do, and on success.
    if ok and remaining > 0 then
        if self._cover_drain then UIManager:unschedule(self._cover_drain) end
        self._cover_drain = function() self._cover_drain = nil; self:_pushCatalog(books) end
        UIManager:scheduleIn(COVER_DRAIN_SECONDS, self._cover_drain)
    end
end

--automatic catalog sync: just the read-history books (cheap, runs on its own without user action).
function ContextSync:syncLibrary()
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end
    self:_pushCatalog(self:buildLibrary())
end

--re-read and push one book's catalog entry right now. called when koreader reports its metadata or cover
--just changed (see main.lua), so the web reflects the change immediately instead of at the next sync.
function ContextSync:syncBookMeta(file)
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end
    if not file or file == "" or file == "unknown" then return end
    local util = require("util")
    local md5 = util.partialMD5(file)
    if not md5 then return end
    self:forgetCoverTried(md5) --it changed, so let its cover/metadata be re-extracted
    self:_pushCatalog({ { book_id = md5, file = file } }) --title/authors/series/cover all come from the re-read
end

--user-triggered "sync all": scan the whole book folder so unopened books appear on the web too. heavier,
--so it's a deliberate action rather than part of the background polling.
function ContextSync:syncAllBooks(interactive)
    if not self:isConfigured() then
        if interactive then UIManager:show(InfoMessage:new{ text = _("Sync isn't set up. Set the server URL, username and password first.") }) end
        return
    end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then
        if interactive then UIManager:show(InfoMessage:new{ text = _("No network connection.") }) end
        return
    end
    if interactive then UIManager:show(InfoMessage:new{ text = _("Scanning your library\u{2026}"), timeout = 2 }) end
    --defer the scan a tick so the message paints first (the walk briefly blocks the ui thread)
    UIManager:scheduleIn(0.1, function()
        local books = self:buildLibraryAll()
        self:_pushCatalog(books)
        if interactive then
            UIManager:show(InfoMessage:new{ text = T(_("Syncing %1 books from your library to the web."), #books) })
        end
    end)
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
    if not ok then
        if list == 401 then self:authFailed() end
        return
    end
    if type(list) ~= "table" then return end
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
        buttons = { {
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
                    self._auth_prompted = false -- re-arm the 401 prompt: if these creds are also bad, warn again
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
        {
            text = _("Sync all books on device"),
            help_text = _("Scan your whole book folder and send every book (with covers) to the web, even ones you haven't opened yet."),
            keep_menu_open = true,
            callback = function() self:syncAllBooks(true) end,
        },
    }
end

return ContextSync
