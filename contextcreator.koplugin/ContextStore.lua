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

--book-level chapter summaries (AI-generated or hand-written), SHARED across every profile of the book.
--they live here in G_reader_settings keyed by the book (NOT inside any one profile's json), so all
--profiles show the same set without drift. load() folds the map onto doc.book so the summaries ride
--along in every export + sync push. keyed by ContextText.normalizeWord(chapter title), so the key is
--stable across devices. each value is { text, updated, source = "ai"|"user", model? }.
function ContextStore:summariesSetting()
    return G_reader_settings:readSetting("contextcreator_chapter_summaries") or {}
end

function ContextStore:getBookSummaries()
    local all = self:summariesSetting()
    return all[self:getBookKey()] or {}
end

function ContextStore:saveBookSummaries(map)
    local all = self:summariesSetting()
    all[self:getBookKey()] = map
    G_reader_settings:saveSetting("contextcreator_chapter_summaries", all)
end

--set/replace one chapter's summary (stamping `updated` for last-write-wins), persist, and fire
--on_change so the sync layer schedules a push (the pushed doc carries the map via load()). chapter is
--the raw TOC title; we normalize it to the stored key. returns the stored entry, or nil if no title.
function ContextStore:setChapterSummary(chapter_title, text, source, model)
    local key = ContextText.normalizeWord(chapter_title)
    if key == "" then return nil end
    local map = self:getBookSummaries()
    map[key] = { text = text, updated = ContextSchema.now(), source = source or "ai", model = model }
    self:saveBookSummaries(map)
    if self.on_change and not self._suppress then self.on_change() end
    return map[key]
end

--read one chapter's summary entry by raw TOC title, or nil.
function ContextStore:getChapterSummary(chapter_title)
    local key = ContextText.normalizeWord(chapter_title or "")
    if key == "" then return nil end
    return self:getBookSummaries()[key]
end

--fold chapter summaries arriving in a merged/synced doc back into the authoritative per-book map
--(last-write-wins per chapter by `updated`), so a summary made on another device/the web lands in the
--shared map and then shows in every local profile. does NOT fire on_change (adopting, not editing).
function ContextStore:adoptBookSummaries(incoming)
    if type(incoming) ~= "table" then return end
    local map = self:getBookSummaries()
    local changed = false
    for key, entry in pairs(incoming) do
        if type(entry) == "table" and entry.text then
            local cur = map[key]
            local cur_u = cur and tonumber(cur.updated) or -1
            local in_u = tonumber(entry.updated) or 0
            if not cur or in_u > cur_u then
                map[key] = { text = entry.text, updated = in_u, source = entry.source or "ai", model = entry.model }
                changed = true
            end
        end
    end
    if changed then self:saveBookSummaries(map) end
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

--max characters of a chapter's text we send to the AI, and how many pdf pages we'll scan per chapter:
--keeps token cost + latency (and a blocking http call) bounded on big chapters. 60k chars (~15k tokens,
--~10k words) covers essentially every novel chapter in full.
local CHAPTER_TEXT_BUDGET = 60000
local PDF_PAGE_CAP = 80

--the book's chapters as { { title, pos0, pos1 }, ... } in reading order, where pos0/pos1 bound a chapter
--for text extraction: xpointers for reflowable (epub/CRE) books, page numbers for paged (pdf) ones. pos1
--is the next chapter's start (the last chapter runs to the end of the book). nil if there's no usable TOC.
function ContextStore:getChapterList()
    local ui = self.ui
    local doc = ui.document
    local toc = ui.toc and ui.toc.toc
    if not doc or not toc or #toc == 0 then return nil end
    local out = {}
    if ui.rolling then
        --reflowable: bound each chapter by consecutive TOC xpointers
        local marks = {}
        for _, item in ipairs(toc) do
            if item.xpointer then marks[#marks + 1] = { title = item.title, xp = item.xpointer } end
        end
        if #marks == 0 then return nil end
        --document-end xpointer so the final chapter has an upper bound (no "next" TOC entry)
        local last_xp
        local okc, pc = pcall(function() return doc:getPageCount() end)
        if okc and pc and pc > 0 then
            local oke, xp = pcall(function() return doc:getPageXPointer(pc) end)
            if oke then last_xp = xp end
        end
        for i, m in ipairs(marks) do
            out[#out + 1] = { title = m.title, pos0 = m.xp, pos1 = (marks[i + 1] and marks[i + 1].xp) or last_xp }
        end
    else
        --paged (pdf): bound each chapter by page numbers
        local total
        local okn, pc = pcall(function() return doc:getPageCount() end)
        if okn then total = pc end
        local marks = {}
        for _, item in ipairs(toc) do
            if item.page then marks[#marks + 1] = { title = item.title, page = item.page } end
        end
        if #marks == 0 then return nil end
        for i, m in ipairs(marks) do
            local nextp = (marks[i + 1] and (marks[i + 1].page - 1)) or total
            out[#out + 1] = { title = m.title, pos0 = m.page, pos1 = nextp }
        end
    end
    if #out == 0 then return nil end
    return out
end

--flatten the nested line/word-box structure pdf text comes back as into a plain string
function ContextStore:flattenTextBoxes(boxes)
    local words = {}
    for _, line in ipairs(boxes or {}) do
        if type(line) == "table" then
            for _, box in ipairs(line) do
                if type(box) == "table" and box.word then words[#words + 1] = box.word end
            end
        end
    end
    return table.concat(words, " ")
end

--extract a chapter's text given pos0/pos1 from getChapterList. returns (text, truncated) on success or
--(nil, err) on failure. CRE/epub reads the text between the two chapter xpointers; pdf concatenates page
--text across the chapter's page range (capped). text is truncated to a character budget for cost/latency.
function ContextStore:getChapterText(pos0, pos1)
    local ui = self.ui
    local doc = ui.document
    if not doc then return nil, "no document" end
    local text
    if ui.rolling then
        if type(pos0) ~= "string" or type(pos1) ~= "string" then return nil, "no chapter bounds" end
        local ok, t = pcall(function() return doc:getTextFromXPointers(pos0, pos1) end)
        if ok and type(t) == "string" then text = t end
    else
        local p0, p1 = tonumber(pos0), tonumber(pos1)
        if not p0 then return nil, "no chapter bounds" end
        p1 = p1 or p0
        if p1 < p0 then p1 = p0 end
        if p1 - p0 + 1 > PDF_PAGE_CAP then p1 = p0 + PDF_PAGE_CAP - 1 end
        local parts = {}
        for p = p0, p1 do
            local ok, boxes = pcall(function() return doc:getPageTextBoxes(p) end)
            if ok and boxes then
                local s = self:flattenTextBoxes(boxes)
                if s ~= "" then parts[#parts + 1] = s end
            end
        end
        text = table.concat(parts, "\n")
    end
    if not text or text == "" then return nil, "no text" end
    local truncated = false
    if #text > CHAPTER_TEXT_BUDGET then
        text = text:sub(1, CHAPTER_TEXT_BUDGET)
        truncated = true
    end
    return text, truncated
end

--how many characters of book text go into a SINGLE ai call. the whole book is split into consecutive
--chunks of about this size so a long book is covered fully across several calls (each fast enough to beat
--the http timeout and small enough that the reply isn't truncated), instead of trimming the book.
--~160k chars ≈ 40k tokens per call.
local PER_CALL_BUDGET = 160000

--split the whole book into ordered chunks for the multi-call "build profile" pass. each chunk is
--{ text = "## title\n...## title\n...", titles = { chapter titles in this chunk } }, with the text under
--PER_CALL_BUDGET (a single oversized chapter still gets its own chunk). returns the chunk list (covering
--EVERY chapter) or nil if the book has no readable chapters.
function ContextStore:getBookChunks()
    local chapters = self:getChapterList()
    if not chapters then return nil end
    local chunks = {}
    local cur = { text = {}, titles = {}, total = 0 }
    local function flush()
        if #cur.titles > 0 then
            chunks[#chunks + 1] = { text = table.concat(cur.text, "\n\n"), titles = cur.titles }
        end
        cur = { text = {}, titles = {}, total = 0 }
    end
    for _, ch in ipairs(chapters) do
        local t = self:getChapterText(ch.pos0, ch.pos1)
        if t and t ~= "" then
            local block = "## " .. (ch.title or "") .. "\n" .. t
            --start a new chunk before this chapter if the current one is non-empty and would overflow
            if cur.total > 0 and cur.total + #block > PER_CALL_BUDGET then flush() end
            cur.text[#cur.text + 1] = block
            cur.titles[#cur.titles + 1] = ch.title
            cur.total = cur.total + #block
        end
    end
    flush()
    if #chunks == 0 then return nil end
    return chunks
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
    --book-level chapter summaries live in G_reader_settings, shared across all profiles. fold any copy
    --carried in this profile's json (e.g. an imported doc) into that shared map, then surface the shared
    --map on the doc so it rides along in every export + sync push and shows in every profile.
    if type(doc.book.chapter_summaries) == "table" and next(doc.book.chapter_summaries) ~= nil then
        self:adoptBookSummaries(doc.book.chapter_summaries)
    end
    local sums = self:getBookSummaries()
    doc.book.chapter_summaries = (next(sums) ~= nil) and sums or nil

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
