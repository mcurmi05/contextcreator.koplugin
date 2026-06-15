--[[
all of the on device UI, the menus and dialogs for browsing contexts, editing dot
points, typing contexts, and creating/editing relationships

built with a ContextStore, it loads/saves through that and never touches the filesystem. 
pure data operations live in ContextSchema, pure text helpers in ContextText
]]

local Button = require("ui/widget/button")
local ButtonDialog = require("ui/widget/buttondialog")
local HorizontalSpan = require("ui/widget/horizontalspan")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local Menu = require("ui/widget/menu")
local Size = require("ui/size")
local UIManager = require("ui/uimanager")
local Screen = require("device").screen
local _ = require("gettext")
local T = require("ffi/util").template
local ContextText = require("ContextText")
local ContextSchema = require("ContextSchema")

--bullet shown in front of each dot point in the list view
local BULLET = "\u{2022} "

--margin kept around the context windows so the book stays visible behind them
local WINDOW_MARGIN = Screen:scaleBySize(80)

--glyph between the two ends of a relationship, a one way arrow when directed, a two way one when not.
--missing directed field means it was made before undirected existed, treat those as directed
local function relArrow(rel)
    return rel.directed == false and "\u{2194}" or "\u{2192}"
end

--"3 dot points" / "1 dot point", for the count shown next to a context name
local function pointsLabel(n)
    if n == 1 then return _("1 dot point") end
    return T(_("%1 dot points"), n)
end

--a Menu that doesn't flash or select its section-header rows (items with _header set).
--Menu rebuilds the row widgets on every page change, so we re-neutralise the headers each time.
--when headers_holdable is set, custom-type headers keep their long-press (so they can be renamed).
local SectionedMenu = Menu:extend{}
function SectionedMenu:updateItems(select_number, no_recalculate_dimen)
    Menu.updateItems(self, select_number, no_recalculate_dimen)
    for _, row in ipairs(self.item_group) do
        local e = row.entry
        if e and e._header then
            row.onTapSelect = function() return true end  --consume the tap, no invert flash, no callback
            if not (self.headers_holdable and e._custom_type) then
                row.onHoldSelect = function() return true end
            end
        end
    end
end

--section headers for the built-in types, in display order. custom-type sections are appended after
--these (alphabetically) and "No type" goes last, all built in groupedContextItems below.
local BUILTIN_SECTIONS = {
    { type = "character", header = _("Characters") },
    { type = "place",     header = _("Locations") },
    { type = "object",    header = _("Objects") },
    { type = "concept",   header = _("Concepts") },
}

--build the flat item list for a contexts menu, grouped under bold section headers.
--exclude_key drops one node (used by the link picker to hide the node being linked from).
--show_counts appends "(N dot points)" to each row. custom-type headers carry _custom_type so the
--caller can offer to rename them.
local function groupedContextItems(doc, exclude_key, show_counts)
    --bucket contexts by type
    local buckets = {}
    for key, node in pairs(doc.contexts) do
        if key ~= exclude_key then
            local t = (node.type == nil or node.type == "") and "unset" or node.type
            buckets[t] = buckets[t] or {}
            table.insert(buckets[t], { key = key, title = node.title, n = #node.points })
        end
    end

    --section order: built-ins, then custom types (alphabetical), then "No type"
    local sections = {}
    for i = 1, #BUILTIN_SECTIONS do
        sections[#sections + 1] = BUILTIN_SECTIONS[i]
    end
    local customs = {}
    for t in pairs(buckets) do
        if ContextSchema.isCustomType(t) then customs[#customs + 1] = t end
    end
    table.sort(customs, function(a, b) return a:lower() < b:lower() end)
    for i = 1, #customs do
        sections[#sections + 1] = {
            type = customs[i],
            header = T(_("%1 (custom)"), ContextSchema.typeLabel(customs[i])),
            custom = customs[i],
        }
    end
    sections[#sections + 1] = { type = "unset", header = _("No type") }

    local items = {}
    for si = 1, #sections do
        local section = sections[si]
        local list = buckets[section.type]
        if list and #list > 0 then
            table.sort(list, function(a, b) return a.title:lower() < b.title:lower() end)
            table.insert(items, { text = section.header, bold = true, _header = true, _custom_type = section.custom })
            for ni = 1, #list do
                local entry = list[ni]
                table.insert(items, {
                    text = show_counts and T("%1  (%2)", entry.title, pointsLabel(entry.n)) or entry.title,
                    _key = entry.key,
                    _title = entry.title,
                })
            end
        end
    end
    return items
end

--the type choices for the pickers: the built-ins, plus any custom types already used in this book
local function typeOptions(doc)
    local opts = {}
    for i = 1, #ContextSchema.NODE_TYPES do
        local t = ContextSchema.NODE_TYPES[i]
        if t ~= "unset" and not ContextSchema.isCustomType(t) then
            opts[#opts + 1] = { label = ContextSchema.typeLabel(t), type = t }
        end
    end
    local seen, customs = {}, {}
    for _key, node in pairs(doc.contexts) do
        if ContextSchema.isCustomType(node.type) and not seen[node.type] then
            seen[node.type] = true
            customs[#customs + 1] = node.type
        end
    end
    table.sort(customs, function(a, b) return a:lower() < b:lower() end)
    for i = 1, #customs do
        opts[#opts + 1] = { label = T(_("%1 (custom)"), customs[i]), type = customs[i] }
    end
    return opts
end

local ContextView = {}
ContextView.__index = ContextView

function ContextView:new(store)
    return setmetatable({ store = store }, ContextView)
end


--editing

--open a node: show its dot points, or jump straight to adding one if it is empty/new
--title is the display name to use when the node does not exist yet (brand new from a word)
function ContextView:openContext(key, title)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if not node or #node.points == 0 then
        self:editPoint(key, (node and node.title) or title or key, nil)
    else
        self:showPointsList(key)
    end
end

--existing contexts that are similar (but not an exact match) to the word, best first
--keys are already normalized, so we compare the word's normalized form against them directly
function ContextView:findSimilarNodes(doc, word)
    local norm = ContextText.normalizeWord(word)
    local matches = {}
    for key, node in pairs(doc.contexts) do
        if key ~= norm then
            local score = ContextText.similarity(norm, key)
            if score >= ContextText.SIMILARITY_THRESHOLD then
                table.insert(matches, { key = key, title = node.title, score = score })
            end
        end
    end
    table.sort(matches, function(a, b) return a.score > b.score end)
    return matches
end

--resolve a highlighted word to a node, then start adding a dot point to it.
--an exact (normalized) match goes straight to a new dot point; fuzzy look-alikes go through the chooser.
--pos is the book locator of the highlight, carried so the new point can be anchored to it.
function ContextView:showEntryEditor(word, pos)
    local key = ContextText.normalizeWord(word)
    if key == "" then return end

    local doc = self.store:load()
    local node = doc.contexts[key]
    if node then
        --exact match: add a point to it, with the option to redirect to a different context
        self:editPoint(key, node.title, nil, nil, true, pos)
        return
    end

    local similar = self:findSimilarNodes(doc, word)
    if #similar > 0 then
        self:showSimilarChooser(word, similar, pos)
    else
        self:createNewContext(ContextText.trim(word), pos) -- brand new, run the name -> type -> point setup
    end
end

--ask the user whether the word belongs to one of the similar existing contexts
function ContextView:showSimilarChooser(word, similar, pos)
    local dialog
    local buttons = {}
    for i = 1, #similar do
        local m = similar[i]
        table.insert(buttons, {{
            text = T(_("Add to \u{201C}%1\u{201D}"), m.title),
            callback = function()
                UIManager:close(dialog)
                self:editPoint(m.key, m.title, nil, nil, true, pos) -- existing context, jump to a new dot point (redirectable)
            end,
        }})
    end
    table.insert(buttons, {{
        text = _("Create new context instead"),
        callback = function()
            UIManager:close(dialog)
            self:createNewContext(ContextText.trim(word), pos)
        end,
    }})
    table.insert(buttons, {{
        text = _("Cancel"),
        callback = function() UIManager:close(dialog) end,
    }})

    dialog = ButtonDialog:new{
        title = T(_("\u{201C}%1\u{201D} looks similar to existing contexts. Add to one of them?"), ContextText.trim(word)),
        title_align = "center",
        buttons = buttons,
    }
    UIManager:show(dialog)
end

--brand new context setup, step 1: confirm/edit the name (prefilled from the highlighted word).
--pos carries the highlight location through to the first dot point.
function ContextView:createNewContext(name, pos)
    --do we already have any contexts? if so we can offer to pick one instead of making a new one
    local has_existing = next(self.store:load().contexts) ~= nil

    local dialog
    local rows = {{
        {
            text = _("Cancel"),
            id = "close",
            callback = function() UIManager:close(dialog) end,
        },
        {
            text = _("Next"),
            is_enter_default = true,
            callback = function()
                local title = ContextText.trim(dialog:getInputText())
                UIManager:close(dialog)
                if title == "" then return end
                local key = ContextText.normalizeWord(title)
                if key == "" then return end
                --if the typed name lands on a context that already exists, add a point to that one
                local doc = self.store:load()
                local existing = doc.contexts[key]
                if existing then
                    self:editPoint(key, existing.title, nil, nil, true, pos)
                else
                    self:chooseTypeForNewContext(key, title, pos)
                end
            end,
        },
    }}
    --escape hatch: maybe this really is a context we already made but the matcher didnt catch it.
    --let the user pick it from the list instead (only worth showing once some contexts exist)
    if has_existing then
        table.insert(rows, {{
            text = _("Select existing context instead"),
            callback = function()
                UIManager:close(dialog)
                self:showExistingContextPicker(pos)
            end,
        }})
    end

    dialog = InputDialog:new{
        title = _("New context"),
        input = name or "",
        input_hint = _("Context name"),
        buttons = rows,
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--pick from the contexts already in this book, then jump straight to a new dot point for it
function ContextView:showExistingContextPicker(pos)
    local doc = self.store:load()
    local items = {}
    for key, node in pairs(doc.contexts) do
        local label = ContextSchema.typeLabel(node.type)
        local text = label ~= "" and T("%1  \u{00B7} %2", node.title, label) or node.title
        table.insert(items, { text = text, _key = key, _title = node.title })
    end

    if #items == 0 then
        UIManager:show(InfoMessage:new{ text = _("No contexts in this book yet.") })
        return
    end

    table.sort(items, function(a, b) return a._title:lower() < b._title:lower() end)

    local menu
    menu = Menu:new{
        title = _("Pick an existing context"),
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:editPoint(item._key, item._title, nil, nil, true, pos)
        end,
        close_callback = function() UIManager:close(menu) end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--brand new context setup, step 2: pick a type, then drop into the first dot point
function ContextView:chooseTypeForNewContext(key, title, pos)
    local doc = self.store:load()
    local dialog
    --apply the chosen type then go to the first dot point. a real/custom type is saved up front so the
    --context sticks even before a point is added; unset is left unsaved (the node gets created when
    --the first point lands, or when "Skip for now" is tapped on the dot point page)
    local function pickType(t)
        if t ~= "unset" then
            local d = self.store:load()
            if not d.contexts[key] then
                --anchor the new context to the reading position so it has a timeline slot
                local a = self.store:describeLocator(pos) or {}
                d.contexts[key] = {
                    title = title, type = t, points = {}, updated = ContextSchema.now(),
                    progress = a.progress, chapter = a.chapter,
                }
                self.store:save(d)
            end
        end
        self:editPoint(key, title, nil, true, false, pos) -- allow "Skip for now" on the first point
    end

    local buttons = {}
    local opts = typeOptions(doc)
    for i = 1, #opts do
        local o = opts[i]
        buttons[#buttons + 1] = {{
            text = o.label,
            callback = function() UIManager:close(dialog); pickType(o.type) end,
        }}
    end
    buttons[#buttons + 1] = {{
        text = _("Custom type\u{2026}"),
        callback = function()
            UIManager:close(dialog)
            self:promptCustomType(pickType)
        end,
    }}
    --cancel and "Skip for now" (no type yet) share the bottom row, cancel on the left
    buttons[#buttons + 1] = {
        {
            text = _("Cancel"),
            callback = function() UIManager:close(dialog) end,
        },
        {
            text = _("Skip for now"),
            callback = function() UIManager:close(dialog); pickType("unset") end,
        },
    }

    dialog = ButtonDialog:new{
        title = T(_("What type of context is \u{201C}%1\u{201D}?"), title),
        title_align = "center",
        buttons = buttons,
    }
    UIManager:show(dialog)
end

--insert a borderless text button next to a Menus bottom pagenavigation bar.
--side == "left" puts it before the chevrons, "right" puts it after them.
--(menu.page_info is the HorizontalGroup holding the page-turn chevrons and "Page x of y")
function ContextView:addFooterButton(menu, side, text, callback)
    local button = Button:new{
        text = text,
        bordersize = 0,
        show_parent = menu,
        callback = callback,
    }
    local span = HorizontalSpan:new{ width = Size.span.horizontal_default }
    if side == "left" then
        table.insert(menu.page_info, 1, span)
        table.insert(menu.page_info, 1, button)
    else
        table.insert(menu.page_info, span)
        table.insert(menu.page_info, button)
    end
    menu.page_info:resetLayout() --recompute positions/size so the bar re-centers with the new buttons
end

--show the dot points for a node as a list. tap to add/edit, long-press to delete.
--the title carries the node's type (when set) so it stays visible while reading the points.
function ContextView:showPointsList(key)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if not node then return end
    local points = node.points

    local items = {}
    for i, point in ipairs(points) do
        --dot points are about what you're learning, not bookmarks, so no page shown here.
        --the location is still stored (long-press a point -> "Go to location" to jump there).
        table.insert(items, {
            text = BULLET .. ContextSchema.pointText(point):gsub("%s*\n%s*", " "), --collapse multi line points to one line
            _index = i,
        })
    end

    local label = ContextSchema.typeLabel(node.type)
    local bracket = label ~= "" and T(_("(%1 context)"), label) or _("(Unset context type)")
    local title = T(_("%1  \u{00B7} %2"), node.title, bracket)

    local menu
    menu = Menu:new{
        title = title,
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false, --keep the border but drop Menus rounded corners
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:editPoint(key, node.title, item._index)
        end,
        onMenuHold = function(_self, item)
            self:showPointActions(menu, key, item._index)
            return true
        end,
        close_callback = function()
            UIManager:close(menu)
        end,
    }

    --flank the bottom page-navigation bar: "All contexts" on the left, then this context's
    --relationships and "Add dot point" on the right
    self:addFooterButton(menu, "left", T(_("\u{2190} All contexts for %1"), self.store:getBookTitle()), function()
        UIManager:close(menu)
        self:showAllContexts()
    end)
    self:addFooterButton(menu, "right", _("\u{2194} Relationships"), function()
        UIManager:close(menu)
        self:showRelationships(key)
    end)
    self:addFooterButton(menu, "right", _("\u{FF0B} Add dot point"), function()
        UIManager:close(menu)
        self:editPoint(key, node.title, nil)
    end)

    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--long-press a dot point: jump to where it was noted (if anchored), or delete it
function ContextView:showPointActions(menu, key, index)
    local doc = self.store:load()
    local node = doc.contexts[key]
    local pos = node and node.points[index] and ContextSchema.pointPos(node.points[index])

    local dialog
    local buttons = {}
    if pos then
        table.insert(buttons, {{
            text = _("Go to location"),
            callback = function()
                UIManager:close(dialog)
                UIManager:close(menu)
                self.store:gotoLocator(pos)
            end,
        }})
    end
    table.insert(buttons, {{
        text = _("Delete"),
        callback = function()
            UIManager:close(dialog)
            local d = self.store:load()
            local n = d.contexts[key]
            if n then
                table.remove(n.points, index)
                n.updated = ContextSchema.now()
                self.store:save(d)
            end
            UIManager:close(menu)
            self:returnToList(key)
        end,
    }})
    table.insert(buttons, {{
        text = _("Cancel"),
        callback = function() UIManager:close(dialog) end,
    }})

    dialog = ButtonDialog:new{
        title = pos and _("Dot point") or _("Delete this dot point?"),
        title_align = "center",
        buttons = buttons,
    }
    UIManager:show(dialog)
end

--edit a single dot point, index == nil means we are adding a new one.
--title is the contexts display name, needed when the node does not exist on disk yet.
--allow_skip adds a "Skip for now" button (only used while creating a brand new context) so the
--user can initialise the context without writing a point yet.
--allow_redirect adds an "Add dot point to different context instead" button (used when we landed
--here from "Add to context") so the user can send the point to another context.
--pos is a book locator for a NEW point, anchoring it to where it was noted (editing keeps the old pos).
--newlines stay inside the one point, a new point is only made via "Add dot point".
function ContextView:editPoint(key, title, index, allow_skip, allow_redirect, pos)
    local doc = self.store:load()
    local node = doc.contexts[key]
    local points = node and node.points or {}
    title = (node and node.title) or title or key
    local existing = index and ContextSchema.pointText(points[index]) or ""

    --resolve the book anchor (highlight pos, or current reading position) once, lazily, only if we
    --actually create something. gives { pos, progress, chapter } for the timeline.
    local anchor
    local function getAnchor()
        if anchor == nil then anchor = self.store:describeLocator(pos) or {} end
        return anchor
    end

    --create the node on disk if it isnt there yet, with the given type (defaults to unset).
    --stamp it with the reading position so it has a timeline slot even before any located point.
    local function ensureNode(node_type)
        if not node then
            local a = getAnchor()
            node = { title = title, type = node_type or "unset", points = points, updated = ContextSchema.now() }
            if a.progress then node.progress = a.progress end
            if a.chapter then node.chapter = a.chapter end
            doc.contexts[key] = node
        end
        return node
    end

    local function persist()
        if #points > 0 then
            ensureNode()
            node.points = points
            node.updated = ContextSchema.now()
            doc.tombstones.contexts[key] = nil -- it's alive again, clear any stale deletion mark
        elseif node then
            node.updated = ContextSchema.now() -- emptied an existing context, it stays around now
        end
        self.store:save(doc)
    end

    local dialog
    local rows = {{
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
                local text = ContextText.trim(dialog:getInputText())
                if text == "" then
                    if index then table.remove(points, index) end -- emptied -> delete it
                elseif index then
                    --edit in place, keeping the point's existing location
                    local p = points[index]
                    if type(p) == "table" then p.text = text else points[index] = { text = text } end
                else
                    --new point, anchored to where it was noted (for jump-back + the timeline)
                    local a = getAnchor()
                    local p = { text = text }
                    if a.pos ~= nil then p.pos = a.pos end
                    if a.progress then p.progress = a.progress end
                    if a.chapter then p.chapter = a.chapter end
                    table.insert(points, p)
                end
                persist()
                UIManager:close(dialog)
                self:returnToList(key)
            end,
        },
    }}
    --while creating a brand new context, let the user set it up without a point yet
    if index == nil and allow_skip then
        table.insert(rows, {{
            text = _("Skip for now"),
            callback = function()
                ensureNode()        -- keep the freshly created context even with no points
                self.store:save(doc)
                UIManager:close(dialog)
            end,
        }})
    end
    --when we got here from "Add to context", let the user redirect the point to another context
    if index == nil and allow_redirect then
        table.insert(rows, {{
            text = _("Add dot point to different context instead"),
            callback = function()
                UIManager:close(dialog)
                self:showExistingContextPicker()
            end,
        }})
    end

    dialog = InputDialog:new{
        title = index and T(_("Edit dot point for \u{201C}%1\u{201D} context"), title) or T(_("New dot point for \u{201C}%1\u{201D} context"), title),
        input = existing,
        input_hint = _("Type your dot point..."),
        description = _("Use as many lines as you like, this stays as one dot point."),
        allow_newline = true, --enter inserts a newline, tap a button to commit
        text_height = Screen:scaleBySize(180),
        buttons = rows,
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--after editing, reopen the list if anything remains, otherwise return to reading
function ContextView:returnToList(key)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if node and #node.points > 0 then
        self:showPointsList(key)
    end
end


--viewing contexts for a book

function ContextView:showAllContexts()
    local doc = self.store:load()

    if next(doc.contexts) == nil then
        UIManager:show(InfoMessage:new{
            text = _("No context entries for this book yet.\n\nLong-press a word while reading and tap \"Add to context\" to start."),
        })
        return
    end

    local items = groupedContextItems(doc, nil, true)

    local menu
    menu = SectionedMenu:new{
        title = T(_("Contexts: %1"), self.store:getBookTitle()),
        item_table = items,
        headers_holdable = true, --custom-type headers can be long-pressed to rename
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false, --keep the border but drop Menus rounded corners
        onMenuSelect = function(_self, item)
            if item._header then return end --section headers aren't tappable
            UIManager:close(menu)
            self:openContext(item._key)
        end,
        onMenuHold = function(_self, item)
            if item._header then
                if item._custom_type then self:renameCustomType(item._custom_type, menu) end
                return true
            end
            self:showNodeActions(menu, item._key)
            return true
        end,
        close_callback = function()
            UIManager:close(menu)
        end,
    }

    --a "Relationships" shortcut on the bottom bar once any links exist, opening the book-wide list
    if #doc.relationships > 0 then
        self:addFooterButton(menu, "right", T(_("\u{2194} Relationships (%1)"), #doc.relationships), function()
            UIManager:close(menu)
            self:showRelationships(nil)
        end)
    end

    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--rename a custom type (reached by long-pressing its section header). retypes every context using
--it to the new name, folding into a built-in if the new name matches one.
function ContextView:renameCustomType(old_type, menu)
    local dialog
    dialog = InputDialog:new{
        title = _("Rename context type"),
        input = old_type,
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
                    local name = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if name == "" then return end
                    local new_type = ContextSchema.resolveType(name)
                    if new_type == old_type then return end
                    local doc = self.store:load()
                    local stamp = ContextSchema.now()
                    for _key, node in pairs(doc.contexts) do
                        if node.type == old_type then
                            node.type = new_type
                            node.updated = stamp
                        end
                    end
                    self.store:save(doc)
                    if menu then UIManager:close(menu) end
                    self:showAllContexts()
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--ask for a custom type name, then hand the resolved type to the callback
function ContextView:promptCustomType(callback)
    local dialog
    dialog = InputDialog:new{
        title = _("Custom context type"),
        input = "",
        input_hint = _("e.g. faction, event, theme\u{2026}"),
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Set type"),
                is_enter_default = true,
                callback = function()
                    local name = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if name == "" then return end
                    callback(ContextSchema.resolveType(name))
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--long press a node: set its type, link it to another node, view its relationships, rename or delete
function ContextView:showNodeActions(menu, key)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if not node then return end

    local dialog
    dialog = ButtonDialog:new{
        title = node.title,
        title_align = "center",
        buttons = {
            {{
                text = T(_("Set type (currently %1)"), ContextSchema.typeLabel(node.type) ~= "" and ContextSchema.typeLabel(node.type) or _("unset")),
                callback = function()
                    UIManager:close(dialog)
                    self:setNodeType(menu, key)
                end,
            }},
            {{
                text = _("Link to\u{2026}"),
                callback = function()
                    UIManager:close(dialog)
                    self:showLinkPicker(menu, key)
                end,
            }},
            {{
                text = _("Relationships"),
                callback = function()
                    UIManager:close(dialog)
                    UIManager:close(menu)
                    self:showRelationships(key)
                end,
            }},
            {{
                text = _("Edit name"),
                callback = function()
                    UIManager:close(dialog)
                    self:renameNode(menu, key)
                end,
            }},
            {{
                text = _("Delete"),
                callback = function()
                    UIManager:close(dialog)
                    local d = self.store:load()
                    ContextSchema.deleteNode(d, key)
                    self.store:save(d)
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

--pick the node's type: built-ins, any existing custom types, a "Custom type..." option, or unset
function ContextView:setNodeType(menu, key)
    local doc = self.store:load()
    local node = doc.contexts[key]
    local is_unset = not node or node.type == nil or node.type == "" or node.type == "unset"

    local dialog
    --apply the type and go back to the list. kept out of the button handlers so the custom-type
    --path (which closes the dialog itself before prompting) can reuse it
    local function setType(t)
        local d = self.store:load()
        local n = d.contexts[key]
        if n then
            n.type = t
            n.updated = ContextSchema.now()
            self.store:save(d)
        end
        UIManager:close(menu)
        self:showAllContexts()
    end

    local buttons = {}
    local opts = typeOptions(doc)
    for i = 1, #opts do
        local o = opts[i]
        buttons[#buttons + 1] = {{
            text = o.label,
            callback = function() UIManager:close(dialog); setType(o.type) end,
        }}
    end
    buttons[#buttons + 1] = {{
        text = _("Custom type\u{2026}"),
        callback = function()
            UIManager:close(dialog)
            self:promptCustomType(setType)
        end,
    }}
    --bottom row: cancel, plus "Unset type" only when there's actually a type to clear
    local bottom = {{
        text = _("Cancel"),
        callback = function() UIManager:close(dialog) end,
    }}
    if not is_unset then
        table.insert(bottom, {
            text = _("Unset type"),
            callback = function() UIManager:close(dialog); setType("unset") end,
        })
    end
    buttons[#buttons + 1] = bottom

    dialog = ButtonDialog:new{
        title = _("What type of context is this?"),
        title_align = "center",
        buttons = buttons,
    }
    UIManager:show(dialog)
end

--rename a node. if the new name normalizes onto an existing node, merge into it (and repoint links);
--otherwise the node moves to the new key. the old key is tombstoned either way.
function ContextView:renameNode(menu, key)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if not node then return end

    local dialog
    dialog = InputDialog:new{
        title = _("Rename context"),
        input = node.title,
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
                    local new_title = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if new_title == "" or new_title == node.title then return end
                    local new_key = ContextText.normalizeWord(new_title)
                    if new_key == "" then return end

                    if new_key == key then
                        --same identity, just a display-name tweak
                        node.title = new_title
                        node.updated = ContextSchema.now()
                    else
                        local target = doc.contexts[new_key]
                        if target then -- another node already owns this name: merge points in
                            for _, p in ipairs(node.points) do
                                table.insert(target.points, p)
                            end
                            target.updated = ContextSchema.now()
                        else
                            node.title = new_title
                            node.updated = ContextSchema.now()
                            doc.contexts[new_key] = node
                        end
                        ContextSchema.repointRelationships(doc, key, new_key)
                        doc.contexts[key] = nil
                        doc.tombstones.contexts[key] = ContextSchema.now()
                        doc.tombstones.contexts[new_key] = nil
                    end
                    self.store:save(doc)
                    UIManager:close(menu)
                    self:showAllContexts()
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end


--relationships

--pick another node to link this one to, then ask for the relationship's label.
--grouped by type like the all-contexts list, with the node we're linking from left out.
function ContextView:showLinkPicker(menu, from_key)
    local doc = self.store:load()
    local items = groupedContextItems(doc, from_key, false)

    if #items == 0 then
        UIManager:show(InfoMessage:new{
            text = _("There is no other context to link to yet.\n\nAdd another context first, then link them."),
        })
        return
    end

    local picker
    picker = SectionedMenu:new{
        title = T(_("Link \u{201C}%1\u{201D} to\u{2026}"), ContextSchema.titleForKey(doc, from_key)),
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            if item._header then return end --section headers aren't tappable
            UIManager:close(picker)
            self:editRelationshipLabel(menu, from_key, item._key)
        end,
        onMenuHold = function(_self, item)
            return true --no per-node action here
        end,
        close_callback = function() UIManager:close(picker) end,
    }
    UIManager:show(picker, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--name the link (e.g. "married to", "lives in"), then ask which way it points, then create it
function ContextView:editRelationshipLabel(menu, from_key, to_key)
    local doc = self.store:load()
    local dialog
    dialog = InputDialog:new{
        title = T(_("How are they related?\n%1 \u{2194} %2"), ContextSchema.titleForKey(doc, from_key), ContextSchema.titleForKey(doc, to_key)),
        input = "",
        input_hint = _("e.g. married to, lives in, kills\u{2026}"),
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Next"),
                is_enter_default = true,
                callback = function()
                    local label = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if label == "" then return end
                    if menu then UIManager:close(menu) end
                    self:askDirection(label, from_key, to_key, function(rel_from, rel_to, directed)
                        local d = self.store:load()
                        local rel = {
                            id = ContextSchema.genId(),
                            from = rel_from,
                            to = rel_to,
                            label = label,
                            directed = directed,
                            points = {},
                            updated = ContextSchema.now(),
                        }
                        table.insert(d.relationships, rel)
                        self.store:save(d)
                        self:showRelationshipView(rel.id) -- jump in so the user can add context to the link
                    end)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--ask which way a link points: a_key -> b_key, b_key -> a_key (the flip), or no direction.
--on_pick(from, to, directed) does the actual create-or-update work.
function ContextView:askDirection(label, a_key, b_key, on_pick)
    local doc = self.store:load()
    local a = ContextSchema.titleForKey(doc, a_key)
    local b = ContextSchema.titleForKey(doc, b_key)
    local dialog
    dialog = ButtonDialog:new{
        title = T(_("Which way does \u{201C}%1\u{201D} go?"), label),
        title_align = "center",
        buttons = {
            {{
                text = T(_("%1  \u{2192}  %2"), a, b),
                callback = function() UIManager:close(dialog); on_pick(a_key, b_key, true) end,
            }},
            {{
                text = T(_("%1  \u{2192}  %2"), b, a), -- the flip
                callback = function() UIManager:close(dialog); on_pick(b_key, a_key, true) end,
            }},
            {{
                text = T(_("%1  \u{2194}  %2  (no direction)"), a, b),
                callback = function() UIManager:close(dialog); on_pick(a_key, b_key, false) end,
            }},
            {{
                text = _("Cancel"),
                callback = function() UIManager:close(dialog) end,
            }},
        },
    }
    UIManager:show(dialog)
end

--list relationships. key == nil lists every link in the book; otherwise only those touching that node.
function ContextView:showRelationships(key)
    local doc = self.store:load()
    local items = {}
    for _, rel in ipairs(doc.relationships) do
        if key == nil or rel.from == key or rel.to == key then
            table.insert(items, {
                text = T("%1  %2  %3  (%4)", ContextSchema.titleForKey(doc, rel.from),
                    relArrow(rel), ContextSchema.titleForKey(doc, rel.to), rel.label),
                _id = rel.id,
            })
        end
    end

    if #items == 0 then
        UIManager:show(InfoMessage:new{
            text = key and _("No relationships for this context yet.\n\nLong-press it and choose \"Link to\u{2026}\" to add one.")
                or _("No relationships in this book yet.\n\nLong-press a context and choose \"Link to\u{2026}\" to add one."),
        })
        return
    end

    table.sort(items, function(a, b) return a.text:lower() < b.text:lower() end)

    local title = key and T(_("Relationships: %1"), ContextSchema.titleForKey(doc, key)) or _("All relationships")
    local menu
    menu = Menu:new{
        title = title,
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:showRelationshipView(item._id)
        end,
        onMenuHold = function(_self, item)
            self:showRelationshipActions(menu, item._id, key)
            return true
        end,
        close_callback = function() UIManager:close(menu) end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--a single relationship: its dot points, with footer buttons to rename the link or add a point.
--tap a point to edit it, long-press to delete it (mirrors the node points list).
function ContextView:showRelationshipView(rel_id)
    local doc = self.store:load()
    local rel = ContextSchema.findRel(doc, rel_id)
    if not rel then return end

    local items = {}
    for i, point in ipairs(rel.points) do
        table.insert(items, {
            text = BULLET .. ContextSchema.pointText(point):gsub("%s*\n%s*", " "),
            _index = i,
        })
    end

    local menu
    menu = Menu:new{
        title = T(_("%1  %2  %3  (%4)"), ContextSchema.titleForKey(doc, rel.from), relArrow(rel), ContextSchema.titleForKey(doc, rel.to), rel.label),
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:editRelPoint(rel_id, item._index)
        end,
        onMenuHold = function(_self, item)
            self:showRelPointActions(menu, rel_id, item._index)
            return true
        end,
        close_callback = function() UIManager:close(menu) end,
    }

    self:addFooterButton(menu, "left", _("\u{270E} Edit label"), function()
        UIManager:close(menu)
        self:renameRelationship(rel_id)
    end)
    self:addFooterButton(menu, "right", _("\u{FF0B} Add dot point"), function()
        UIManager:close(menu)
        self:editRelPoint(rel_id, nil)
    end)

    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--long-press a relationship in the list: change its direction or delete it (delete is tombstoned for sync)
function ContextView:showRelationshipActions(menu, rel_id, list_key)
    local doc = self.store:load()
    local rel = ContextSchema.findRel(doc, rel_id)
    if not rel then return end

    local dialog
    dialog = ButtonDialog:new{
        title = T("%1  %2  %3  (%4)", ContextSchema.titleForKey(doc, rel.from), relArrow(rel),
            ContextSchema.titleForKey(doc, rel.to), rel.label),
        title_align = "center",
        buttons = {
            {{
                text = _("Direction"),
                callback = function()
                    UIManager:close(dialog)
                    self:askDirection(rel.label, rel.from, rel.to, function(rel_from, rel_to, directed)
                        local d = self.store:load()
                        local r = ContextSchema.findRel(d, rel_id)
                        if r then
                            r.from = rel_from
                            r.to = rel_to
                            r.directed = directed
                            r.updated = ContextSchema.now()
                            self.store:save(d)
                        end
                        UIManager:close(menu)
                        self:showRelationships(list_key)
                    end)
                end,
            }},
            {{
                text = _("Delete"),
                callback = function()
                    UIManager:close(dialog)
                    local d = self.store:load()
                    local _, idx = ContextSchema.findRel(d, rel_id)
                    if idx then
                        d.tombstones.relationships[rel_id] = ContextSchema.now()
                        table.remove(d.relationships, idx)
                        self.store:save(d)
                    end
                    UIManager:close(menu)
                    self:showRelationships(list_key)
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

--rename the relationship's label
function ContextView:renameRelationship(rel_id)
    local doc = self.store:load()
    local rel = ContextSchema.findRel(doc, rel_id)
    if not rel then return end

    local dialog
    dialog = InputDialog:new{
        title = _("Edit relationship label"),
        input = rel.label,
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function()
                    UIManager:close(dialog)
                    self:showRelationshipView(rel_id)
                end,
            },
            {
                text = _("Save"),
                is_enter_default = true,
                callback = function()
                    local label = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if label ~= "" then
                        rel.label = label
                        rel.updated = ContextSchema.now()
                        self.store:save(doc)
                    end
                    self:showRelationshipView(rel_id)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--edit/add a dot point on a relationship. index == nil adds a new one. mirrors editPoint for contexts.
function ContextView:editRelPoint(rel_id, index)
    local doc = self.store:load()
    local rel = ContextSchema.findRel(doc, rel_id)
    if not rel then return end
    local existing = index and ContextSchema.pointText(rel.points[index]) or ""

    local dialog
    dialog = InputDialog:new{
        title = index and T(_("Edit dot point for \u{201C}%1\u{201D}"), rel.label) or T(_("New dot point for \u{201C}%1\u{201D}"), rel.label),
        input = existing,
        input_hint = _("Type your dot point..."),
        description = _("Use as many lines as you like, this stays as one dot point."),
        allow_newline = true,
        text_height = Screen:scaleBySize(180),
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function()
                    UIManager:close(dialog)
                    self:showRelationshipView(rel_id)
                end,
            },
            {
                text = index and _("Save") or _("Add dot point"),
                callback = function()
                    local text = ContextText.trim(dialog:getInputText())
                    if text == "" then
                        if index then table.remove(rel.points, index) end
                    elseif index then
                        local p = rel.points[index]
                        if type(p) == "table" then p.text = text else rel.points[index] = { text = text } end
                    else
                        table.insert(rel.points, { text = text })
                    end
                    rel.updated = ContextSchema.now()
                    self.store:save(doc)
                    UIManager:close(dialog)
                    self:showRelationshipView(rel_id)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--long-press a relationship dot point, offer to delete it
function ContextView:showRelPointActions(menu, rel_id, index)
    local dialog
    dialog = ButtonDialog:new{
        title = _("Delete this dot point?"),
        title_align = "center",
        buttons = {
            {{
                text = _("Delete"),
                callback = function()
                    UIManager:close(dialog)
                    local doc = self.store:load()
                    local rel = ContextSchema.findRel(doc, rel_id)
                    if rel then
                        table.remove(rel.points, index)
                        rel.updated = ContextSchema.now()
                        self.store:save(doc)
                    end
                    UIManager:close(menu)
                    self:showRelationshipView(rel_id)
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

return ContextView
