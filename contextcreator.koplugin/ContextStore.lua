--[[
per book persistence, one json file per book under a "contextcreator" folder

built with the reader ui so it can read the current books title/authors/id, and owns reading
and writing the document (handing shape/migration off to ContextSchema). the rest of the
plugin only ever talks to load()/save(), it never touches the filesystem directly
]]

local DataStorage = require("datastorage")
local Event = require("ui/event")
local rapidjson = require("rapidjson")
local util = require("util")
local logger = require("logger")
local ContextText = require("ContextText")
local ContextSchema = require("ContextSchema")

local ContextStore = {}
ContextStore.__index = ContextStore

function ContextStore:new(ui)
    return setmetatable({ ui = ui }, ContextStore)
end

function ContextStore:getStoreDir()
    --start from KOReaders home folder, fall back to the data dir if none is set
    local home = G_reader_settings:readSetting("home_dir") or DataStorage:getDataDir()
    --go one directory out of the home folder, then keep our files in a "contextcreator" folder there
    local parent = util.splitFilePathName((home:gsub("/+$", "")))
    local dir = parent:gsub("/+$", "") .. "/contextcreator"
    util.makePath(dir)
    return dir
end

function ContextStore:getBookFile()
    return (self.ui.document and self.ui.document.file) or "unknown"
end

function ContextStore:getBookTitle()
    local props = self.ui.doc_props or {}
    local title = props.display_title or props.title
    if not title or title == "" then
        local _path, name = util.splitFilePathName(self:getBookFile())
        title = name
    end
    return title or "Untitled"
end

--the file for a given profile id. the "default" profile keeps the plain <title>.json name (so books
--from before profiles existed just keep working), other profiles get a <title>.<id>.json file.
function ContextStore:profileFilePath(pid)
    local base = self:getStoreDir() .. "/" .. ContextText.sanitizeFilename(self:getBookTitle())
    if pid == "default" then return base .. ".json" end
    return base .. "." .. pid .. ".json"
end

--the file for the currently active profile.
function ContextStore:getBookFilePath()
    return self:profileFilePath(self:getProfileId())
end

--profiles: a book can hold several named context docs, the user picks which to read/write on the device
--(independent of the web's choice). the active id + known list live in G_reader_settings keyed by the
--book's sync id (falling back to its title when the id isn't known), so the choice persists per book.
function ContextStore:getBookKey()
    return self:getBookId() or ContextText.sanitizeFilename(self:getBookTitle())
end

function ContextStore:profilesSetting()
    return G_reader_settings:readSetting("contextcreator_profiles") or {}
end

function ContextStore:bookProfiles()
    local all = self:profilesSetting()
    return all[self:getBookKey()] or { active = "default", list = { { id = "default", name = "Main" } } }
end

function ContextStore:saveBookProfiles(bp)
    local all = self:profilesSetting()
    all[self:getBookKey()] = bp
    G_reader_settings:saveSetting("contextcreator_profiles", all)
end

function ContextStore:getProfileId()
    return self:bookProfiles().active or "default"
end

function ContextStore:setProfileId(id)
    local bp = self:bookProfiles()
    bp.active = id or "default"
    self:saveBookProfiles(bp)
end

function ContextStore:getProfileList()
    local list = self:bookProfiles().list
    if not list or #list == 0 then return { { id = "default", name = "Main" } } end
    return list
end

--replace the known profile list (e.g. after pulling it from the server), keeping the active selection.
--if the active profile is no longer in the list (e.g. it was deleted on the web), fall back to the first.
function ContextStore:setProfileList(list)
    local bp = self:bookProfiles()
    bp.list = (list and #list > 0) and list or { { id = "default", name = "Main" } }
    local has_active = false
    for _, p in ipairs(bp.list) do if p.id == bp.active then has_active = true break end end
    if not has_active then bp.active = bp.list[1].id end
    self:saveBookProfiles(bp)
end

--rename a profile in the local list (the server is told separately by the sync layer)
function ContextStore:renameProfile(id, name)
    local bp = self:bookProfiles()
    for _, p in ipairs(bp.list or {}) do
        if p.id == id then p.name = name end
    end
    self:saveBookProfiles(bp)
end

--remove a profile locally: drop it from the list, delete its json file, and switch off it if it was
--active. recreates a default if it was the last one. returns the (possibly new) active id.
function ContextStore:removeProfile(id)
    local bp = self:bookProfiles()
    local kept = {}
    for _, p in ipairs(bp.list or {}) do
        if p.id ~= id then kept[#kept + 1] = p end
    end
    if #kept == 0 then kept = { { id = "default", name = "Main" } } end
    bp.list = kept
    if bp.active == id then bp.active = kept[1].id end
    self:saveBookProfiles(bp)
    os.remove(self:profileFilePath(id)) --best-effort; the file may not exist
    return bp.active
end

--mark a local profile as confirmed on the server, so a later sync can tell a brand-new local-only
--profile (keep it) apart from one the server has since dropped (deleted on the web -> remove it).
function ContextStore:markProfileSynced(id)
    local bp = self:bookProfiles()
    local changed = false
    for _, p in ipairs(bp.list or {}) do
        if p.id == id and not p.synced then p.synced = true; changed = true end
    end
    if changed then self:saveBookProfiles(bp) end
end

function ContextStore:getProfileName(id)
    for _, p in ipairs(self:getProfileList()) do
        if p.id == id then return p.name end
    end
    return id == "default" and "Main" or id
end

--create a new profile locally and make it active. returns its id. the next sync registers it (with its
--name) on the server, which is also where it gets its initial (empty) contents.
function ContextStore:addProfile(name)
    local id = "k-" .. ContextSchema.genId() --device-origin profile id
    local bp = self:bookProfiles()
    bp.list = bp.list or { { id = "default", name = "Main" } }
    bp.list[#bp.list + 1] = { id = id, name = name }
    bp.active = id
    self:saveBookProfiles(bp)
    return id
end

--the stable per book id used for sync, koreaders partial md5 of the file (same hash kosync uses,
--robust against title/filename changes). may be nil for some formats, we still work without it
function ContextStore:getBookId()
    local ds = self.ui.doc_settings
    return ds and ds:readSetting("partial_md5_checksum") or nil
end

function ContextStore:getBookAuthors()
    local props = self.ui.doc_props or {}
    return props.authors or props.author or props.Author or ""
end

--the books series name from koreaders metadata, so the webapp can group books into series on its own.
--some metadata packs the index in like "Red Rising #2", strip that so we just keep the name
function ContextStore:getBookSeries()
    local props = self.ui.doc_props or {}
    local s = props.series
    if type(s) ~= "string" or s == "" then return nil end
    local name = s:match("^(.-)%s*#%s*[%d%.]+%s*$")
    return (name and name ~= "") and name or s
end

--the books position in its series (1 based, may be a float), from metadata or parsed out of the name
function ContextStore:getBookSeriesIndex()
    local props = self.ui.doc_props or {}
    local idx = props.series_index
    if type(idx) == "number" then return idx end
    if type(idx) == "string" and idx ~= "" then return tonumber(idx) end
    if type(props.series) == "string" then
        local n = props.series:match("#%s*([%d%.]+)")
        if n then return tonumber(n) end
    end
    return nil
end

--describe a book locator for the timeline: returns { pos, progress, chapter, page }.
--pos is the locator we anchored to (the one given, or the current reading position if pos is nil),
--kept for on-device jump-back. progress is a 0..1 fraction through the book (the universal,
--file-independent timeline axis the webapp scrubs). chapter is the TOC title at that spot.
--all fields are best-effort, any may be nil. computed here because only the device has the book.
function ContextStore:describeLocator(pos)
    local ui = self.ui
    local doc = ui.document
    local res = {}
    if not doc then return res end

    if ui.rolling then
        --reflowable (epub/CRE): everything keys off an xpointer
        local xp = (type(pos) == "string") and pos or nil
        if not xp then
            local ok, cur = pcall(function() return doc:getXPointer() end)
            xp = ok and cur or nil
        end
        if xp then
            res.pos = xp
            local height = doc.info and doc.info.doc_height
            local ok, y = pcall(function() return doc:getPosFromXPointer(xp) end)
            if ok and y and height and height > 0 then res.progress = y / height end
            local okp, page = pcall(function() return doc:getPageFromXPointer(xp) end)
            if okp then res.page = page end
            if ui.toc then
                local okc, ch = pcall(function() return ui.toc:getTocTitleByPage(xp) end)
                if okc and ch and ch ~= "" then res.chapter = ch end
            end
            --fraction through the current chapter (0..1). chapter boundaries are logical (the same on
            --every device), but the raw y/height progress is render-dependent and drifts between devices,
            --so the webapp re-anchors a device onto a shared timeline as chapter + this fraction rather
            --than trusting the bare fraction. only computed for the live position (pos == nil).
            if pos == nil and ui.toc and ui.toc.toc and res.progress and height and height > 0 then
                local items = ui.toc.toc
                local function chprog(it)
                    local lx = it and it.xpointer
                    if not lx then return nil end
                    local oky, yy = pcall(function() return doc:getPosFromXPointer(lx) end)
                    if oky and yy then return yy / height end
                    return nil
                end
                local startp, nextp
                for i = 1, #items do
                    local p = chprog(items[i])
                    if p ~= nil then
                        if p <= res.progress + 1e-9 then startp = p
                        else nextp = p; break end
                    end
                end
                if startp then
                    nextp = nextp or 1
                    if nextp > startp then
                        res.chapter_frac = math.max(0, math.min(1, (res.progress - startp) / (nextp - startp)))
                    end
                end
            end
        end
    else
        --paged (pdf): key off the page number
        local page = (type(pos) == "table" and pos.page) or (ui.paging and ui.paging.current_page)
        if page then
            res.pos = { page = page }
            res.page = page
            local okn, total = pcall(function() return doc:getPageCount() end)
            if okn and total and total > 0 then res.progress = page / total end
            if ui.toc then
                local okc, ch = pcall(function() return ui.toc:getTocTitleByPage(page) end)
                if okc and ch and ch ~= "" then res.chapter = ch end
            end
        end
    end
    return res
end

--snapshot the book's chapter list as { { title, progress }, ... } so the webapp can draw labelled
--chapter bands on the timeline without needing the book file. best-effort, nil if no TOC.
function ContextStore:buildTocSnapshot()
    local ui = self.ui
    local toc = ui.toc and ui.toc.toc
    if not toc or #toc == 0 then return nil end
    local out = {}
    for _, item in ipairs(toc) do
        local locator = item.xpointer or (item.page and { page = item.page }) or nil
        local a = self:describeLocator(locator)
        if a.progress then
            out[#out + 1] = { title = item.title, progress = a.progress }
        end
    end
    if #out == 0 then return nil end
    return out
end

--jump the reader to a stored locator (pushing the current spot onto the back stack first so the
--reader's "back" returns here). returns true if it could navigate.
function ContextStore:gotoLocator(pos)
    if not pos then return false end
    local ui = self.ui
    if ui.rolling and type(pos) == "string" then
        if ui.link then ui.link:addCurrentLocationToStack() end
        ui.rolling:onGotoXPointer(pos, pos) -- second arg shows the position marker
        return true
    elseif type(pos) == "table" and pos.page then
        if ui.link then ui.link:addCurrentLocationToStack() end
        ui:handleEvent(Event:new("GotoPage", pos.page))
        return true
    end
    return false
end

--load the document for the current book.
--always returns a well-shaped doc, even when the file is missing or unreadable.
function ContextStore:load()
    local path = self:getBookFilePath()
    local doc
    local f = io.open(path, "r")
    if not f then
        doc = ContextSchema.newDoc()
    else
        local content = f:read("*a")
        f:close()
        local data = nil
        if content and content ~= "" then
            local ok, decoded = pcall(rapidjson.decode, content)
            if ok and type(decoded) == "table" then
                data = decoded
            else
                logger.warn("ContextCreator: could not parse", path)
            end
        end
        doc = data or ContextSchema.newDoc()
    end

    ContextSchema.migrate(doc) --upgrade an older on-disk schema, then normalise shape (+ stamp the version)
    local ids_added = ContextSchema.ensurePointIds(doc) --legacy/imported points get stable ids for clean sync

    --keep the book metadata fresh (cheap, and the id/title can only become known after open)
    doc.book.id = doc.book.id or self:getBookId()
    doc.book.title = self:getBookTitle()
    doc.book.authors = self:getBookAuthors()
    --carry the series grouping up so the webapp can file the book without the user redoing it
    doc.book.series = self:getBookSeries()
    doc.book.series_index = self:getBookSeriesIndex()
    --snapshot the chapter list once so the webapp timeline can show chapter bands without the book
    if not doc.book.toc then
        doc.book.toc = self:buildTocSnapshot()
    end

    --persist freshly assigned point ids so they're stable across loads (without triggering a sync)
    if ids_added then self:replace(doc) end
    return doc
end

--write the document for the current book. file-level updated is bumped so a future sync can
--cheaply tell something changed. an entirely empty doc (no contexts/relationships/tombstones) is removed.
--fires on_change afterwards (unless suppressed) so the sync layer can schedule a push.
function ContextStore:save(doc)
    local path = self:getBookFilePath()
    if ContextSchema.isEmpty(doc) then
        os.remove(path)
        if self.on_change and not self._suppress then self.on_change() end
        return
    end
    --bump the change clock, unless we're adopting an already-merged doc (replace), where we keep the
    --server's `updated` so periodic syncs don't look like endless changes to the other side
    if not self._keep_updated then
        doc.updated = ContextSchema.now()
    end

    --tag the array-typed fields so rapidjson serializes them as JSON arrays. without this an empty
    --array encodes as {} (an object), reloads object-typed, and items appended later get silently
    --dropped on the next encode (see lua-rapidjson __jsontype handling).
    doc.relationships = rapidjson.array(doc.relationships)
    for _, context in pairs(doc.contexts) do
        context.points = rapidjson.array(context.points)
    end
    for _, rel in ipairs(doc.relationships) do
        rel.points = rapidjson.array(rel.points)
    end

    local ok, encoded = pcall(rapidjson.encode, doc, { pretty = true, sort_keys = true })
    if not ok then
        logger.err("ContextCreator: failed to encode doc:", encoded)
        return
    end
    local fw = io.open(path, "w")
    if not fw then
        logger.err("ContextCreator: could not write", path)
        return
    end
    fw:write(encoded)
    fw:close()
    if self.on_change and not self._suppress then self.on_change() end
end

--write a full document verbatim (e.g. one adopted from a sync merge), WITHOUT firing on_change,
--so adopting the server's result doesn't loop back into another sync.
function ContextStore:replace(doc)
    self._suppress = true       --don't fire on_change (no sync loop)
    self._keep_updated = true   --keep the adopted doc's `updated` as-is
    self:save(doc)
    self._keep_updated = false
    self._suppress = false
end

return ContextStore
