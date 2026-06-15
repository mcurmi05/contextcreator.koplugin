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

function ContextStore:getBookFilePath()
    return self:getStoreDir() .. "/" .. ContextText.sanitizeFilename(self:getBookTitle()) .. ".json"
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

    ContextSchema.normalize(doc)

    --keep the book metadata fresh (cheap, and the id/title can only become known after open)
    doc.book.id = doc.book.id or self:getBookId()
    doc.book.title = self:getBookTitle()
    doc.book.authors = self:getBookAuthors()
    --snapshot the chapter list once so the webapp timeline can show chapter bands without the book
    if not doc.book.toc then
        doc.book.toc = self:buildTocSnapshot()
    end
    return doc
end

--write the document for the current book. file-level updated is bumped so a future sync can
--cheaply tell something changed. an entirely empty doc (no contexts/relationships/tombstones) is removed
function ContextStore:save(doc)
    local path = self:getBookFilePath()
    if ContextSchema.isEmpty(doc) then
        os.remove(path)
        return
    end
    doc.updated = ContextSchema.now()

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
end

return ContextStore
