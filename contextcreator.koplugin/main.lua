local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local Menu = require("ui/widget/menu")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local Screen = require("device").screen
local rapidjson = require("rapidjson")
local util = require("util")
local logger = require("logger")
local _ = require("gettext")
local T = require("ffi/util").template

local ContextCreator = WidgetContainer:extend{
    name = "contextcreator",
    -- only active when a document is open; remove this to also load in the file browser
    is_doc_only = true,
}

--normalize a word so that variations of it map to the same context
--lowercases, strips surrounding punctuation, and removes the possessive "'s"
local function normalizeWord(word)
    if not word then return "" end
    word = word:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    word = word:lower()
    word = word:gsub("^[%p]+", ""):gsub("[%p]+$", "")    --trim leading/trailing punctuation
    word = word:gsub("['\u{2019}]s$", "")                --possessive, straight or curly apostrophe
    if #word > 3 then word = word:gsub("s$", "") end     --plural/trailing s (only on longer words, so "bus" stays "bus")
    return word
end

--make sure that strings are safe to use as a file name
local function sanitizeFilename(name)
    name = (name or ""):gsub("[/\\:%*%?\"<>|%c]", "_")
    name = name:gsub("^%.+", ""):gsub("%s+$", "")
    if name == "" then name = "Untitled" end
    return name
end

--bullet shown in front of each dot point in the list view
local BULLET = "\u{2022} "

--trim leading/trailing whitespace from a string
local function trim(text)
    return (text or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

--record a highlighted surface form (e.g. "Mustang's") on a context, de-duped case-insensitively
local function addVariant(entry, surface)
    surface = trim(surface)
    if surface == "" then return end
    local low = surface:lower()
    for _, v in ipairs(entry.variants) do
        if v:lower() == low then return end
    end
    table.insert(entry.variants, surface)
end

function ContextCreator:init()
    self.ui.menu:registerToMainMenu(self)

    --add buttons to the long press/highlight popup
    if self.ui.highlight then
        self.ui.highlight:addToHighlightDialog("13_contextcreator", function(this)
            return {
                text = _("Add to context"),
                callback = function()
                    local word = this.selected_text and this.selected_text.text
                    this:onClose()
                    if word and word ~= "" then
                        self:showEntryEditor(word)
                    end
                end,
            }
        end)
        self.ui.highlight:addToHighlightDialog("14_contextcreator_view", function(this)
            return {
                text = _("View all contexts"),
                callback = function()
                    this:onClose()
                    self:showAllContexts()
                end,
            }
        end)
    end
end


--storage, chose to have a json file per book

function ContextCreator:getStoreDir()
    --start from KOReader's home folder, fall back to the data dir if none is set
    local home = G_reader_settings:readSetting("home_dir") or DataStorage:getDataDir()
    --go one directory out of the home folder, then keep our files in a "contextcreator" folder there
    local parent = util.splitFilePathName((home:gsub("/+$", "")))
    local dir = parent:gsub("/+$", "") .. "/contextcreator"
    util.makePath(dir)
    return dir
end

function ContextCreator:getBookTitle()
    local props = self.ui.doc_props or {}
    local title = props.display_title or props.title
    if not title or title == "" then
        local _path, name = util.splitFilePathName(self:getBookFile())
        title = name
    end
    return title or "Untitled"
end

function ContextCreator:getBookFile()
    return (self.ui.document and self.ui.document.file) or "unknown"
end

function ContextCreator:getBookFilePath()
    return self:getStoreDir() .. "/" .. sanitizeFilename(self:getBookTitle()) .. ".json"
end

--load the {context title -> {points}} table for the current book
function ContextCreator:loadContexts()
    local f = io.open(self:getBookFilePath(), "r")
    if not f then return {} end
    local content = f:read("*a")
    f:close()
    if not content or content == "" then return {} end
    local ok, data = pcall(rapidjson.decode, content)
    if ok and type(data) == "table" then
        --normalize each entry to { points = {...}, variants = {...} }, upgrading the
        --old format where the value was just a plain array of dot points
        for title, entry in pairs(data) do
            if type(entry) ~= "table" then
                data[title] = { points = {}, variants = { title } }
            elseif entry.points == nil then
                data[title] = { points = entry, variants = { title } } -- old array-only format
            else
                entry.variants = entry.variants or { title }
            end
        end
        return data
    end
    logger.warn("ContextCreator: could not parse", self:getBookFilePath())
    return {}
end

function ContextCreator:saveContexts(contexts)
    local path = self:getBookFilePath()
    if next(contexts) == nil then
        os.remove(path)
        return
    end
    local ok, encoded = pcall(rapidjson.encode, contexts, { pretty = true, sort_keys = true })
    if not ok then
        logger.err("ContextCreator: failed to encode contexts:", encoded)
        return
    end
    local f = io.open(path, "w")
    if not f then
        logger.err("ContextCreator: could not write", path)
        return
    end
    f:write(encoded)
    f:close()
end

--find an existing context whose title matches the word
function ContextCreator:findContextKey(contexts, word)
    if contexts[word] then return word end
    local norm = normalizeWord(word)
    for title in pairs(contexts) do
        if normalizeWord(title) == norm then return title end
    end
    return nil
end


--editing

--resolve the word to a context, then show its dot points
--a brand new context has nothing to show, so jump straight to adding a point
function ContextCreator:showEntryEditor(word)
    if normalizeWord(word) == "" then return end

    local contexts = self:loadContexts()
    local key = self:findContextKey(contexts, word) or word
    local entry = contexts[key]

    --pass the highlighted surface form (word) along so it gets recorded as a variant on save
    if not entry or #entry.points == 0 then
        self:editPoint(key, nil, word)
    else
        self:showPointsList(key, word)
    end
end

--show the dot points for a context as a list, with add/edit/delete
--variant is the surface form just highlighted (if any), carried through to editPoint
function ContextCreator:showPointsList(key, variant)
    local contexts = self:loadContexts()
    local entry = contexts[key] or { points = {}, variants = {} }
    local points = entry.points

    local items = {{
        text = _("\u{FF0B} Add dot point"),
        _add = true,
    }}
    for i, point in ipairs(points) do
        table.insert(items, {
            text = BULLET .. point:gsub("%s*\n%s*", " "), --collapse multi line points to one line for the list
            _index = i,
        })
    end

    local menu
    menu = Menu:new{
        title = T(_("Context: %1"), key),
        item_table = items,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:editPoint(key, item._index, variant) -- _index is nil for the "Add dot point" row
        end,
        close_callback = function()
            UIManager:close(menu)
        end,
    }
    UIManager:show(menu)
end

--edit a single dot point, index == nil means we are adding a new one
--newlines stay inside the one point, a new point is only made via "Add dot point".
--variant is the highlighted surface form to record on this context when something is saved
function ContextCreator:editPoint(key, index, variant)
    local contexts = self:loadContexts()
    local entry = contexts[key] or { points = {}, variants = {} }
    local points = entry.points
    local existing = index and points[index] or ""

    local function persist()
        if #points == 0 then
            contexts[key] = nil -- no points left -> drop the context entirely
        else
            entry.points = points
            contexts[key] = entry
        end
        self:saveContexts(contexts)
    end

    local dialog
    local row = {
        {
            text = _("Cancel"),
            id = "close",
            callback = function()
                UIManager:close(dialog)
                self:returnToList(key, variant)
            end,
        },
    }
    if index then
        table.insert(row, {
            text = _("Delete"),
            callback = function()
                table.remove(points, index)
                persist()
                UIManager:close(dialog)
                self:returnToList(key, variant)
            end,
        })
    end
    table.insert(row, {
        text = index and _("Save") or _("Add dot point"),
        callback = function()
            local text = trim(dialog:getInputText())
            if text == "" then
                if index then table.remove(points, index) end -- emptied -> delete it
            elseif index then
                points[index] = text
                addVariant(entry, variant) -- the highlighted form matched this context
            else
                table.insert(points, text)
                addVariant(entry, variant)
            end
            persist()
            UIManager:close(dialog)
            self:returnToList(key, variant)
        end,
    })

    dialog = InputDialog:new{
        title = index and T(_("Edit dot point \u{2014} %1"), key) or T(_("New dot point \u{2014} %1"), key),
        input = existing,
        input_hint = _("Type your dot point..."),
        description = _("Use as many lines as you like \u{2014} this stays one dot point."),
        allow_newline = true, --enter inserts a newline, tap a button to commit
        text_height = Screen:scaleBySize(180),
        buttons = {row},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--after editing, reopen the list if anything remains, otherwise return to reading
function ContextCreator:returnToList(key, variant)
    local contexts = self:loadContexts()
    local entry = contexts[key]
    if entry and #entry.points > 0 then
        self:showPointsList(key, variant)
    end
end


--viewing contexts for a book

function ContextCreator:showAllContexts()
    local contexts = self:loadContexts()
    local items = {}
    for title, entry in pairs(contexts) do
        --show every highlighted word that matched this context, e.g. "Mustang, Mustang's"
        local label = #entry.variants > 0 and table.concat(entry.variants, ", ") or title
        table.insert(items, {
            text = T("%1  (%2)", label, #entry.points),
            _title = title,
        })
    end

    if #items == 0 then
        UIManager:show(InfoMessage:new{
            text = _("No context entries for this book yet.\n\nLong-press a word while reading and tap \"Add to context\" to start."),
        })
        return
    end

    table.sort(items, function(a, b) return a._title:lower() < b._title:lower() end)

    local menu
    menu = Menu:new{
        title = T(_("Contexts: %1"), self:getBookTitle()),
        item_table = items,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:showEntryEditor(item._title)
        end,
        close_callback = function()
            UIManager:close(menu)
        end,
    }
    UIManager:show(menu)
end

--reader menu entry

function ContextCreator:addToMainMenu(menu_items)
    menu_items.contextcreator = {
        text = _("Context Creator"),
        sorting_hint = "tools",
        callback = function() self:showAllContexts() end,
    }
end

return ContextCreator
