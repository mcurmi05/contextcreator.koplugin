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
local logger = require("logger")
local ContextSyncClient = require("ContextSyncClient")

--how long after the last change before we actually push (coalesces a burst of edits into one sync)
local DEBOUNCE_SECONDS = 2
--how often to poll the server while a book is open, so web edits show up (in an open list, even) without
--a manual sync. each tick is skipped instantly when offline, so it won't keep wifi awake on a real device.
local PERIODIC_SECONDS = 5
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

--flush on book close: cancel any pending debounced push and sync now, so the FINAL state goes up —
--including the reading position, which may have moved (even backwards) without any note edit to trigger
--a debounce. otherwise a backwards jump right before closing wouldn't reach the web until the next open.
function ContextSync:flush()
    if self._pending then
        UIManager:unschedule(self._pending)
        self._pending = nil
    end
    self:syncNow()
end

--poll the server every PERIODIC_SECONDS while the book is open, so changes made on the web (or
--another device) appear here without a manual sync. reschedules itself, stop with stopPeriodic.
function ContextSync:startPeriodic()
    if not self:isConfigured() then return end
    self:stopPeriodic()
    self._periodic = function()
        self._periodic = nil
        self:syncNow()
        self:syncProfiles() -- so profile renames/deletes made on the web show up without reopening
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
    local before = doc.updated --so we can tell if the merge brought new content in (web/other-device edit)
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
        self.store:markProfileSynced(profile) -- it now exists server-side (lets syncProfiles spot web deletes)
        self.store:replace(merged) -- adopt the merged result without re-triggering a sync
        --if the merge actually brought something new in (a web/other-device edit, e.g. a dot point added
        --on the webapp), tell the UI so an open list repaints in place instead of needing a close + reopen.
        if type(merged.updated) == "number" and merged.updated ~= before and type(self.on_synced) == "function" then
            self.on_synced()
        end
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
                        title = (name or ""):gsub("%.%w+$", "")  --drop the extension for a cleaner placeholder
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
--the set is also scoped per server+account: a fresh server (e.g. a new deployment with an empty db)
--has none of these covers yet, so pointing the device at it must re-extract and re-send everything even
--though the same books were already sent to a different server. each scope keeps its own tried-set, so
--switching servers back and forth doesn't lose progress either.
local EXTRACT_SCHEMA = 3

--the key identifying the current server+account the tried-set belongs to
function ContextSync:coversScope()
    local s = self:settings()
    return (s.server or "") .. "|" .. (s.username or "")
end

--the whole store as a per-scope map. the old format was a single flat table (with _schema and book_ids
--at the top level), detect that by its top-level _schema and drop it so it migrates to a clean map (a
--one-time re-extract on upgrade, which is fine).
function ContextSync:allCoversTried()
    local all = G_reader_settings:readSetting("contextcreator_covers_tried")
    if type(all) ~= "table" or all._schema ~= nil then return {} end
    return all
end

function ContextSync:coversTried()
    local scope = self:allCoversTried()[self:coversScope()]
    if type(scope) ~= "table" or scope._schema ~= EXTRACT_SCHEMA then
        return { _schema = EXTRACT_SCHEMA } --new scope/schema/missing: start fresh so extraction runs for all
    end
    return scope
end

--persist the current scope's tried-set back into the per-scope map, leaving other scopes untouched
function ContextSync:saveCoversTried(tried)
    local all = self:allCoversTried()
    all[self:coversScope()] = tried
    G_reader_settings:saveSetting("contextcreator_covers_tried", all)
end

function ContextSync:markCoversTried(ids)
    local tried = self:coversTried()
    for _, id in ipairs(ids) do tried[id] = true end
    self:saveCoversTried(tried)
end

--forget a book so its cover/metadata gets re-read next push (used when koreader says it just changed)
function ContextSync:forgetCoverTried(id)
    local tried = self:coversTried()
    if tried[id] then
        tried[id] = nil
        self:saveCoversTried(tried)
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
        --cover extraction is the fragile part (image decode/scale/jpeg-encode all vary by device + book
        --format), so keep it in its own pcall: a failure here must not throw away the title/series/author
        --we already have, otherwise a book whose cover step errors would show up with no metadata at all.
        --each step logs why it bailed so the device log shows what broke when a cover doesnt come through.
        local cok, cerr = pcall(function()
            local bb = BookInfo:getCoverImage(doc) --reuse the already-open document
            if not bb then logger.dbg("ContextCreator: no cover image for", file); return end
            local RenderImage = require("ui/renderimage")
            local w, h = bb:getWidth(), bb:getHeight()
            local scale = math.min(COVER_W / w, COVER_H / h, 1)
            local nw = math.max(1, math.floor(w * scale))
            local nh = math.max(1, math.floor(h * scale))
            local scaled = RenderImage:scaleBlitBuffer(bb, nw, nh, true) --frees the original bb
            if not scaled then logger.warn("ContextCreator: cover scale failed for", file); return end
            local DataStorage = require("datastorage")
            local tmp = DataStorage:getDataDir() .. "/cc_cover_tmp.jpg"
            local wrote = scaled:writeToFile(tmp, "jpg", 80)
            scaled:free()
            if not wrote then logger.warn("ContextCreator: cover writeToFile failed for", file); return end
            local f = io.open(tmp, "rb")
            if not f then return end
            local data = f:read("*a")
            f:close()
            os.remove(tmp)
            if data and data ~= "" then
                local mime = require("mime")
                result.cover = "data:image/jpeg;base64," .. (mime.b64(data))
            end
        end)
        if not cok then logger.warn("ContextCreator: cover extraction error for", file, "->", tostring(cerr)) end
        doc:close() --done with the document; the scaled buffer is already independent memory
        return result
    end)
    if not ok then logger.warn("ContextCreator: extractBookInfo failed for", file, "->", tostring(info)) end
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
            title = (name or ""):gsub("%.%w+$", "")  --drop the extension for a cleaner placeholder until the real title is read
        end
        out[#out + 1] = { book_id = md5, title = title or "", authors = authors or "",
                          series = series or "", series_index = webSeriesIndex(series_index), file = path }
    --recursive, with a high file ceiling so the walk can't run away. this counts every file visited,
    --not just books: each opened book carries a .sdr sidecar folder of several files, so a real library
    --inflates the count fast. keep it well above any plausible book count so the scan isnt cut short
    --before it reaches them all (the real bound is the 500-book cap above).
    end, true, 50000)
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
    --per-session state (this ContextSync instance lives for one book-open): book_ids we've already opened
    --this run, so a document is never reopened twice even while re-sending; and the covers the server last
    --told us it's still missing, so a wiped/restored server gets them re-sent despite our local tried memory.
    self._extracted = self._extracted or {}
    self._need_cover = self._need_cover or {}
    local budget = 6 --opening documents is heavy; only extract a few covers per run
    local fresh = {} --book_ids attempted this run, marked tried once the push lands
    local remaining = 0 --extractable books we didn't get to this run (drives the drain reschedule below)
    local payload = {}
    for _, b in ipairs(books) do
        local item = { book_id = b.book_id, title = b.title, authors = b.authors,
                       series = b.series, series_index = b.series_index }
        --extract when we have the file, haven't opened it yet this run, and either we've never tried it or
        --the server says it still lacks the cover (the latter is what repopulates a freshly wiped server).
        local want = b.file and not self._extracted[b.book_id]
            and (not tried[b.book_id] or self._need_cover[b.book_id])
        if want then
            if budget > 0 then
                budget = budget - 1
                self._extracted[b.book_id] = true --opened this run, never reopen it again this session
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
    --identify this device so the server keeps its covers separate (the web lets the user pick which to show)
    local ok, resp = ContextSyncClient:new(s.server, s.username, s.password):pushLibrary(payload, self:deviceInfo())
    if not ok and resp == 401 then self:authFailed() end
    if ok and #fresh > 0 then self:markCoversTried(fresh) end
    --adopt the server's list of covers it's still missing, so the next drain pass re-sends those. this is
    --what lets a wiped/restored server refill even though we already extracted these once for it before.
    if ok and type(resp) == "table" then
        local nc = {}
        if type(resp.need_cover) == "table" then
            for _, id in ipairs(resp.need_cover) do nc[id] = true end
        end
        self._need_cover = nc
    end
    --keep draining in small batches: while budget-deferred books remain, or the server still wants a cover
    --we can supply (have a file for, not yet opened this run). only chains on a successful push.
    local more = remaining > 0
    if ok and not more then
        for _, b in ipairs(books) do
            if b.file and self._need_cover[b.book_id] and not self._extracted[b.book_id] then more = true; break end
        end
    end
    if ok and more then
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

--whether the once-per-app-session full library scan has already run. a reader plugin re-inits on every
--book open, but the full folder walk is heavy, so we only do it once per process (reset on koreader restart).
local did_startup_full_sync = false

--run the full "sync all books" once per app session, deferred so it never competes with opening a book.
--this is what keeps the web library complete (incl. unopened books) without the user tapping anything, and
--together with the server's need_cover reply it repopulates covers automatically after a server reset.
function ContextSync:syncAllBooksOnStartup()
    if did_startup_full_sync then return end
    did_startup_full_sync = true
    if not self:isConfigured() then return end
    UIManager:scheduleIn(5, function() self:syncAllBooks(false) end)
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
    --the server's authoritative profile set, by id
    local server = {}
    for _, p in ipairs(list) do if p.profile_id then server[p.profile_id] = p end end

    local local_list = self.store:getProfileList()
    local merged, seen = {}, {}
    --walk local profiles in order: adopt the server name when present; drop ones the server no longer has
    --(deleted on the web) UNLESS they're brand-new local-only profiles not yet pushed (kept until synced).
    for _, p in ipairs(local_list) do
        local sp = server[p.id]
        if sp then
            merged[#merged + 1] = { id = p.id, name = sp.name or p.name, synced = true }
            seen[p.id] = true
        elseif p.id == "default" then
            merged[#merged + 1] = { id = p.id, name = p.name, synced = p.synced } --default always exists
            seen[p.id] = true
        elseif not p.synced then
            merged[#merged + 1] = { id = p.id, name = p.name, synced = false } --not pushed yet, keep it
            seen[p.id] = true
        end
        --else: was synced before, gone from the server now => deleted on the web, so drop it (below)
    end
    --append profiles the server knows that we didn't have locally (made on the web / another device)
    for _, p in ipairs(list) do
        if p.profile_id and not seen[p.profile_id] then
            merged[#merged + 1] = { id = p.profile_id, name = p.name or p.profile_id, synced = true }
            seen[p.profile_id] = true
        end
    end
    --clean up local files for any profiles we just dropped (deleted on the web)
    for _, p in ipairs(local_list) do
        if not seen[p.id] then os.remove(self.store:profileFilePath(p.id)) end
    end

    self.store:setProfileList(merged) --also re-points the active selection if it was a dropped profile
end

--push a profile rename made on the device up to the server (best-effort), so the web + other devices
--pick it up. the local list is renamed by the caller; this just propagates it.
function ContextSync:renameProfileRemote(id, name)
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end
    local book_id = self.store:getBookId()
    if not book_id then return end
    local s = self:settings()
    local ok, resp = ContextSyncClient:new(s.server, s.username, s.password):renameProfile(book_id, id, name)
    if not ok and resp == 401 then self:authFailed() end
end

--push a profile delete made on the device up to the server (best-effort).
function ContextSync:deleteProfileRemote(id)
    if not self:isConfigured() then return end
    if NetworkMgr and NetworkMgr.isConnected and not NetworkMgr:isConnected() then return end
    local book_id = self.store:getBookId()
    if not book_id then return end
    local s = self:settings()
    local ok, resp = ContextSyncClient:new(s.server, s.username, s.password):deleteProfile(book_id, id)
    if not ok and resp == 401 then self:authFailed() end
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
