local ButtonDialog = require("ui/widget/buttondialog")
local DataStorage = require("datastorage")
local Dispatcher = require("dispatcher")
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
    word = word:gsub("\u{2019}", "'")                    --curly apostrophe -> straight (Lua patterns are byte-based, so a multibyte char can't live in a [class])
    word = word:gsub("^[%p]+", ""):gsub("[%p]+$", "")    --trim leading/trailing punctuation
    word = word:gsub("'s$", "")                          --possessive 's
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

--margin kept around the context windows so the book stays visible behind them
local WINDOW_MARGIN = Screen:scaleBySize(80)

--trim leading/trailing whitespace from a string
local function trim(text)
    return (text or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

--how alike two contexts must be (0..1) before we suggest merging instead of creating new
local SIMILARITY_THRESHOLD = 0.7

--Levenshtein edit distance between two strings (byte-wise, fine for our short names)
local function levenshtein(a, b)
    local la, lb = #a, #b
    if la == 0 then return lb end
    if lb == 0 then return la end
    local prev = {}
    for j = 0, lb do prev[j] = j end
    for i = 1, la do
        local cur = { [0] = i }
        local ca = a:byte(i)
        for j = 1, lb do
            local cost = (ca == b:byte(j)) and 0 or 1
            cur[j] = math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        end
        prev = cur
    end
    return prev[lb]
end

--similarity of two already-normalized words, 0 (nothing alike) to 1 (identical)
--containment (e.g. "jon" inside "jon snow") counts as a strong match
local function similarity(a, b)
    if a == "" or b == "" then return 0 end
    if a == b then return 1 end
    if #a >= 3 and #b >= 3 and (a:find(b, 1, true) or b:find(a, 1, true)) then
        return 0.9
    end
    return 1 - levenshtein(a, b) / math.max(#a, #b)
end

--register an action so the context viewer can be bound to a gesture, quick menu, entry or profile
function ContextCreator:onDispatcherRegisterActions()
    Dispatcher:registerAction("contextcreator_show", {
        category = "none",
        event = "ShowContextCreator",
        title = _("Context Creator: view contexts"),
        reader = true,
    })
end

function ContextCreator:init()
    self:onDispatcherRegisterActions()
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
    if ok and type(data) == "table" then return data end
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

--open a context: show its dot points, or jump straight to adding one if it is empty/new
function ContextCreator:openContext(key)
    local contexts = self:loadContexts()
    local points = contexts[key]
    if not points or #points == 0 then
        self:editPoint(key, nil)
    else
        self:showPointsList(key)
    end
end

--existing contexts that are similar (but not an exact match) to the word, best first
function ContextCreator:findSimilarContexts(contexts, word)
    local norm = normalizeWord(word)
    local matches = {}
    for title in pairs(contexts) do
        local score = similarity(norm, normalizeWord(title))
        if score >= SIMILARITY_THRESHOLD then
            table.insert(matches, { title = title, score = score })
        end
    end
    table.sort(matches, function(a, b) return a.score > b.score end)
    return matches
end

--resolve the word to a context, then show its dot points
--only an identical title opens straight away, any other match (normalized variants like
--"Bellona"/"Bellonas", or fuzzy look alikes) goes through the chooser so the user confirms
function ContextCreator:showEntryEditor(word)
    if normalizeWord(word) == "" then return end

    local contexts = self:loadContexts()
    if contexts[word] then
        self:openContext(word)
        return
    end

    local similar = self:findSimilarContexts(contexts, word)
    if #similar > 0 then
        self:showSimilarChooser(word, similar)
    else
        self:openContext(word) -- brand new context named after the word
    end
end

--ask the user whether the word belongs to one of the similar existing contexts
function ContextCreator:showSimilarChooser(word, similar)
    local dialog
    local buttons = {}
    for _, m in ipairs(similar) do
        table.insert(buttons, {{
            text = T(_("Add to \u{201C}%1\u{201D}"), m.title),
            callback = function()
                UIManager:close(dialog)
                self:openContext(m.title)
            end,
        }})
    end
    table.insert(buttons, {{
        text = T(_("No, create \u{201C}%1\u{201D}"), word),
        callback = function()
            UIManager:close(dialog)
            self:openContext(word)
        end,
    }})
    table.insert(buttons, {{
        text = _("Cancel"),
        callback = function() UIManager:close(dialog) end,
    }})

    dialog = ButtonDialog:new{
        title = T(_("\u{201C}%1\u{201D} looks similar to existing contexts. Add to one of them?"), word),
        title_align = "center",
        buttons = buttons,
    }
    UIManager:show(dialog)
end

--show the dot points for a context as a list. tap to add/edit, long-press to delete.
function ContextCreator:showPointsList(key)
    local contexts = self:loadContexts()
    local points = contexts[key] or {}

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
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false, --keep the border but drop Menus rounded corners
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:editPoint(key, item._index) -- _index is nil for the "Add dot point" row
        end,
        onMenuHold = function(_self, item)
            if item._index then -- ignore a hold on the "Add dot point" row
                self:showPointActions(menu, key, item._index)
            end
            return true
        end,
        close_callback = function()
            UIManager:close(menu)
        end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--long-press a dot point, offer to delete it
function ContextCreator:showPointActions(menu, key, index)
    local dialog
    dialog = ButtonDialog:new{
        title = _("Delete this dot point?"),
        title_align = "center",
        buttons = {
            {{
                text = _("Delete"),
                callback = function()
                    UIManager:close(dialog)
                    local contexts = self:loadContexts()
                    local points = contexts[key]
                    if points then
                        table.remove(points, index)
                        if #points == 0 then contexts[key] = nil end
                        self:saveContexts(contexts)
                    end
                    UIManager:close(menu)
                    self:returnToList(key)
                end,
            }},
            {{
                text = _("Cancel"),
                callback = function() UIManager:close(dialog) end,
            }},
        },
    }
    UIManager:show(dialog)
end

--edit a single dot point, index == nil means we are adding a new one
--newlines stay inside the one point, a new point is only made via "Add dot point".
function ContextCreator:editPoint(key, index)
    local contexts = self:loadContexts()
    local points = contexts[key] or {}
    local existing = index and points[index] or ""

    local function persist()
        if #points == 0 then
            contexts[key] = nil -- no points left -> drop the context entirely
        else
            contexts[key] = points
        end
        self:saveContexts(contexts)
    end

    local dialog
    dialog = InputDialog:new{
        title = index and T(_("Edit dot point \u{2014} %1"), key) or T(_("New dot point \u{2014} %1"), key),
        input = existing,
        input_hint = _("Type your dot point..."),
        description = _("Use as many lines as you like \u{2014} this stays one dot point."),
        allow_newline = true, --enter inserts a newline, tap a button to commit
        text_height = Screen:scaleBySize(180),
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function()
                    UIManager:close(dialog)
                    self:returnToList(key)
                end,
            },
            {
                text = index and _("Save") or _("Add dot point"),
                callback = function()
                    local text = trim(dialog:getInputText())
                    if text == "" then
                        if index then table.remove(points, index) end -- emptied -> delete it
                    elseif index then
                        points[index] = text
                    else
                        table.insert(points, text)
                    end
                    persist()
                    UIManager:close(dialog)
                    self:returnToList(key)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--after editing, reopen the list if anything remains, otherwise return to reading
function ContextCreator:returnToList(key)
    local contexts = self:loadContexts()
    local points = contexts[key]
    if points and #points > 0 then
        self:showPointsList(key)
    end
end


--viewing contexts for a book

function ContextCreator:showAllContexts()
    local contexts = self:loadContexts()
    local items = {}
    for title, points in pairs(contexts) do
        table.insert(items, {
            text = T("%1  (%2)", title, #points),
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
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false, --keep the border but drop Menus rounded corners
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:showEntryEditor(item._title)
        end,
        onMenuHold = function(_self, item)
            self:showContextActions(menu, item._title)
            return true
        end,
        close_callback = function()
            UIManager:close(menu)
        end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--long press a context, rename it or delete it
function ContextCreator:showContextActions(menu, title)
    local dialog
    dialog = ButtonDialog:new{
        title = title,
        title_align = "center",
        buttons = {
            {{
                text = _("Edit name"),
                callback = function()
                    UIManager:close(dialog)
                    self:renameContext(menu, title)
                end,
            }},
            {{
                text = _("Delete"),
                callback = function()
                    UIManager:close(dialog)
                    local contexts = self:loadContexts()
                    contexts[title] = nil
                    self:saveContexts(contexts)
                    UIManager:close(menu)
                    self:showAllContexts()
                end,
            }},
            {{
                text = _("Cancel"),
                callback = function() UIManager:close(dialog) end,
            }},
        },
    }
    UIManager:show(dialog)
end

--rename a context, if the new name matches an existing context, merge their points
function ContextCreator:renameContext(menu, title)
    local dialog
    dialog = InputDialog:new{
        title = _("Rename context"),
        input = title,
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Save"),
                is_enter_default = true,
                callback = function()
                    local new_name = trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if new_name == "" or new_name == title then return end

                    local contexts = self:loadContexts()
                    local points = contexts[title]
                    if points then
                        contexts[title] = nil
                        local existing = self:findContextKey(contexts, new_name)
                        if existing then -- a different context already covers this name: merge in
                            for _, p in ipairs(points) do
                                table.insert(contexts[existing], p)
                            end
                        else
                            contexts[new_name] = points
                        end
                        self:saveContexts(contexts)
                    end
                    UIManager:close(menu)
                    self:showAllContexts()
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--reader menu entry

function ContextCreator:addToMainMenu(menu_items)
    menu_items.contextcreator = {
        text = _("Context Creator"),
        sorting_hint = "navi", --first/navigation tab
        callback = function() self:showAllContexts() end,
    }
end

--dispatched by the registered contextcreator_show action
function ContextCreator:onShowContextCreator()
    self:showAllContexts()
    return true
end

return ContextCreator
