--[[
all of the on device UI, the menus and dialogs for browsing contexts, editing dot
points, typing contexts, and creating/editing relationships

built with a ContextStore, it loads/saves through that and never touches the filesystem. 
pure data operations live in ContextSchema, pure text helpers in ContextText
]]

local Button = require("ui/widget/button")
local ButtonDialog = require("ui/widget/buttondialog")
local ConfirmBox = require("ui/widget/confirmbox")
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
local ContextAI = require("ContextAI")

--bullet shown in front of each dot point in the list view
local BULLET = "\u{2022} "

--margin kept around the context windows so the book stays visible behind them.
--cap it at a fraction of the screen width so narrow devices (small Kobos) keep a window
--wide enough for the footer buttons (back / relationships / add) instead of clipping them.
local WINDOW_MARGIN = math.min(Screen:scaleBySize(80), math.floor(Screen:getWidth() / 20))

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

--a Menu whose section-header rows (items with _header set) are tappable to collapse/expand their
--section but never hold-selectable — except custom-type headers when headers_holdable is set, which keep
--their long-press so they can be renamed. Menu rebuilds the row widgets on every page change, so we
--re-apply this each time. the tap itself is handled in onMenuSelect (it toggles the section).
local SectionedMenu = Menu:extend{}
function SectionedMenu:updateItems(select_number, no_recalculate_dimen)
    Menu.updateItems(self, select_number, no_recalculate_dimen)
    for _, row in ipairs(self.item_group) do
        local e = row.entry
        if e and e._header and not (self.headers_holdable and e._custom_type) then
            row.onHoldSelect = function() return true end
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
--the progress (0..1) at which a context "appears": its earliest located point, else its own
--anchor progress, else nil (unknown). mirrors the webapp's contextProgress so device + web filter alike.
local function contextIntroProgress(node)
    local min
    for _, p in ipairs(node.points or {}) do
        local pr = type(p) == "table" and p.progress or nil
        if type(pr) == "number" and (min == nil or pr < min) then min = pr end
    end
    if min ~= nil then return min end
    return type(node.progress) == "number" and node.progress or nil
end

--when `expanded` (a type->bool table) is passed, the menu is collapsible: each section header shows a
--▸/▾ disclosure + its count, and the contexts under it are only listed when that type is expanded. with
--`expanded` nil the list isn't collapsible (every context is shown), the original behaviour.
local function groupedContextItems(doc, exclude_key, show_counts, filter_fn, expanded)
    --bucket contexts by type
    local buckets = {}
    for key, node in pairs(doc.contexts) do
        if key ~= exclude_key and (filter_fn == nil or filter_fn(key, node)) then
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

    local collapsible = expanded ~= nil
    local items = {}
    for si = 1, #sections do
        local section = sections[si]
        local list = buckets[section.type]
        if list and #list > 0 then
            table.sort(list, function(a, b) return a.title:lower() < b.title:lower() end)
            local open = (not collapsible) or expanded[section.type]
            local header_text = section.header
            if collapsible then --disclosure arrow + count, so a collapsed section still shows how many it holds
                header_text = T("%1 %2  (%3)", open and "\u{25BE}" or "\u{25B8}", section.header, #list)
            end
            table.insert(items, { text = header_text, bold = true, _header = true,
                                  _custom_type = section.custom, _type = section.type })
            if open then
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

function ContextView:new(store, ai)
    return setmetatable({ store = store, ai = ai }, ContextView)
end

--repaint the currently-open contexts/points list from the freshly-synced local doc, so an edit made on
--the webapp (or another device) shows up without a close + reopen. each list view registers a rebuild
--closure in self._refresh while it's open (cleared when it closes); this just runs it. wrapped in pcall
--so a stale/closed menu can never turn a background sync into a crash.
function ContextView:refreshOpen()
    if self._refresh then pcall(self._refresh) end
end

--whether to hide context info from beyond the current reading position (contexts not yet introduced,
--and dot points noted ahead of where you are). on by default so the book doesn't spoil itself; the
--choice is saved to G_reader_settings so it persists across books and restarts.
function ContextView:getOnlyRead()
    local v = G_reader_settings:readSetting("contextcreator_only_read")
    if v == nil then return true end
    return v
end

function ContextView:setOnlyRead(v)
    G_reader_settings:saveSetting("contextcreator_only_read", v and true or false)
end

--a dot point's 0..1 progress, or nil if it isn't anchored (legacy/imported points)
local function pointProgress(point)
    return type(point) == "table" and type(point.progress) == "number" and point.progress or nil
end

--is a point anchored beyond the reader's current spot (i.e. should be hidden as a "later" note)?
--compares by page when we can: raw progress is finer than a page, so the reading position (the top
--of the page) is a smidge below a note made lower on the same page, which would wrongly hide it.
--comparing page numbers means a note made anywhere on the current page still counts as "here".
--falls back to the 0..1 progress for legacy points / formats without page info.
function ContextView:pointBeyond(point, cur)
    if cur.page then
        local pos = ContextSchema.pointPos(point)
        local page = pos and self.store:describeLocator(pos).page
        if type(page) == "number" then return page > cur.page end
    end
    local pp = pointProgress(point)
    if pp == nil or cur.progress == nil then return false end
    return pp > cur.progress + 1e-6
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

--resolve a word to a context key by an EXACT (normalized) match on the title or any alias.
--returns the context key, or nil if nothing matches exactly.
function ContextView:resolveContextKey(doc, word)
    local norm = ContextText.normalizeWord(word)
    if norm == "" then return nil end
    if doc.contexts[norm] then return norm end --title match
    for key, node in pairs(doc.contexts) do
        for _, alias in ipairs(node.aliases or {}) do
            if ContextText.normalizeWord(alias) == norm then return key end --alias match
        end
    end
    return nil
end

--existing contexts that are similar (but not an exact match) to the word, best first.
--keys are already normalized, so we compare the word's normalized form against them directly,
--and also against each context's aliases so a look-alike of an alias still suggests its context.
function ContextView:findSimilarNodes(doc, word)
    local norm = ContextText.normalizeWord(word)
    local matches = {}
    for key, node in pairs(doc.contexts) do
        if key ~= norm then
            local score = ContextText.similarity(norm, key)
            for _, alias in ipairs(node.aliases or {}) do
                score = math.max(score, ContextText.similarity(norm, ContextText.normalizeWord(alias)))
            end
            if score >= ContextText.SIMILARITY_THRESHOLD then
                table.insert(matches, { key = key, title = node.title, score = score })
            end
        end
    end
    table.sort(matches, function(a, b) return a.score > b.score end)
    return matches
end

--resolve a highlighted word to a node, then start adding a dot point to it.
--an exact (normalized) match goes straight to a new dot point, fuzzy look-alikes go through the chooser.
--pos is the book locator of the highlight, carried so the new point can be anchored to it.
function ContextView:showEntryEditor(word, pos)
    if ContextText.normalizeWord(word) == "" then return end

    local doc = self.store:load()
    local key = self:resolveContextKey(doc, word) --exact title or alias match
    if key then
        local node = doc.contexts[key]
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

--resolve a highlighted word to an existing context and open its dot points.
--an exact (normalized) match opens straight away; fuzzy look-alikes go through a chooser;
--nothing alike just reports that there's no matching context.
function ContextView:openMatchingContext(word, pos)
    if ContextText.normalizeWord(word) == "" then return end

    local doc = self.store:load()
    local key = self:resolveContextKey(doc, word) --exact title or alias match
    if key then
        self:showPointsList(key) --exact match, open it immediately
        return
    end

    local similar = self:findSimilarNodes(doc, word)
    if #similar == 0 then
        --no context yet: offer to create one for the highlighted word
        local dialog
        local buttons = {
            {{
                text = T(_("Create \u{201C}%1\u{201D}"), ContextText.trim(word)),
                callback = function()
                    UIManager:close(dialog)
                    self:createNewContext(ContextText.trim(word), pos)
                end,
            }},
        }
        --only worth offering once at least one context exists to attach it to
        if next(doc.contexts) ~= nil then
            table.insert(buttons, {{
                text = _("Add as alias to existing context"),
                callback = function()
                    UIManager:close(dialog)
                    self:addWordAsAlias(word)
                end,
            }})
        end
        table.insert(buttons, {{
            text = _("Cancel"),
            callback = function() UIManager:close(dialog) end,
        }})
        dialog = ButtonDialog:new{
            title = T(_("No context matches \u{201C}%1\u{201D} yet."), ContextText.trim(word)),
            title_align = "center",
            buttons = buttons,
        }
        UIManager:show(dialog)
    else
        self:showOpenChooser(word, similar, pos) --close matches: let the user pick which to open
    end
end

--list the contexts that look like the highlighted word and open whichever one is chosen,
--or create a brand new context for the word if none of them are right
function ContextView:showOpenChooser(word, similar, pos)
    local dialog
    local buttons = {}
    for i = 1, #similar do
        local m = similar[i]
        table.insert(buttons, {{
            text = T(_("Open \u{201C}%1\u{201D}"), m.title),
            callback = function()
                UIManager:close(dialog)
                self:showPointsList(m.key)
            end,
        }})
    end
    table.insert(buttons, {{
        text = T(_("Create \u{201C}%1\u{201D} instead"), ContextText.trim(word)),
        callback = function()
            UIManager:close(dialog)
            self:createNewContext(ContextText.trim(word), pos)
        end,
    }})
    table.insert(buttons, {{
        text = _("Add as alias to existing context"),
        callback = function()
            UIManager:close(dialog)
            self:addWordAsAlias(word)
        end,
    }})
    table.insert(buttons, {{
        text = _("Cancel"),
        callback = function() UIManager:close(dialog) end,
    }})

    dialog = ButtonDialog:new{
        title = T(_("Open a context matching \u{201C}%1\u{201D}?"), ContextText.trim(word)),
        title_align = "center",
        buttons = buttons,
    }
    UIManager:show(dialog)
end

--brand new context setup, step 1: confirm/edit the name (prefilled from the highlighted word).
--pos carries the highlight location through to the first dot point.
--prev_key is set when we arrive here via "Back" from the type step: it's the context we
--provisionally created, so a name change can clean it up instead of leaving an orphan.
function ContextView:createNewContext(name, pos, prev_key)
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
                local doc = self.store:load()
                --renamed away from a provisional context we made earlier in this flow: drop it if empty
                if prev_key and prev_key ~= key then
                    local prev = doc.contexts[prev_key]
                    if prev and #prev.points == 0 then
                        ContextSchema.deleteNode(doc, prev_key)
                        self.store:save(doc)
                    end
                end
                --if the typed name lands on a context that already exists (and isn't the one we're
                --still building), add a point to that one; otherwise carry on to the type step
                local existing = doc.contexts[key]
                if existing and key ~= prev_key then
                    self:editPoint(key, existing.title, nil, nil, true, pos)
                else
                    self:chooseTypeForNewContext(key, title, pos)
                end
            end,
        },
    }}
    --escape hatch: maybe this really is a context we already made but the matcher didnt catch it.
    --let the user add a point to it, or attach this name to it as an alias (both only worth showing
    --once some contexts exist)
    if has_existing then
        table.insert(rows, {
            {
                text = _("Select existing context instead"),
                callback = function()
                    UIManager:close(dialog)
                    self:showExistingContextPicker(pos)
                end,
            },
            {
                text = _("Add as alias to existing context"),
                callback = function()
                    local alias = ContextText.trim(dialog:getInputText())
                    if alias == "" then alias = name or "" end
                    UIManager:close(dialog)
                    self:addWordAsAlias(alias)
                end,
            },
        })
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
--a reusable context picker: contexts grouped under their type headers, each section a collapsible
--dropdown that starts closed (tap a header to open it). on_pick(menu, key, title) fires on a row tap.
--exclude_key/filter_fn restrict which contexts are offered. used wherever the user picks a context.
function ContextView:showContextPicker(opts)
    local doc = opts.doc or self.store:load()
    local expanded = {} --type -> true; empty table means every section starts collapsed
    local function buildItems()
        return groupedContextItems(doc, opts.exclude_key, opts.show_counts, opts.filter_fn, expanded)
    end
    if #buildItems() == 0 then
        UIManager:show(InfoMessage:new{ text = opts.empty_text or _("No contexts in this book yet.") })
        return
    end
    local menu
    menu = SectionedMenu:new{
        title = opts.title,
        item_table = buildItems(),
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            if item._header then --tap a type header to collapse/expand its dropdown, rebuilt in place
                expanded[item._type] = (not expanded[item._type]) and true or nil
                menu:switchItemTable(opts.title, buildItems())
                return
            end
            opts.on_pick(menu, item._key, item._title)
        end,
        close_callback = function() UIManager:close(menu) end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
    return menu
end

function ContextView:showExistingContextPicker(pos)
    self:showContextPicker{
        title = _("Pick an existing context"),
        on_pick = function(menu, key, title)
            UIManager:close(menu)
            self:editPoint(key, title, nil, nil, true, pos)
        end,
    }
end

--brand new context setup, step 2: pick a type, then drop into the first dot point
function ContextView:chooseTypeForNewContext(key, title, pos)
    local doc = self.store:load()
    local dialog
    --apply the chosen type then go to the first dot point. a real/custom type is saved up front so the
    --context sticks even before a point is added, unset is left unsaved (the node gets created when
    --the first point lands, or when "Skip for now" is tapped on the dot point page)
    local function pickType(t)
        if t ~= "unset" then
            local d = self.store:load()
            local node = d.contexts[key]
            if node then
                --came back to change the type of a context we already created: update it in place
                node.type = t
                node.updated = ContextSchema.now()
            else
                --anchor the new context to the reading position so it has a timeline slot
                local a = self.store:describeLocator(pos) or {}
                d.contexts[key] = {
                    title = title, type = t, points = {}, updated = ContextSchema.now(),
                    progress = a.progress, chapter = a.chapter,
                }
            end
            self.store:save(d)
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
    --bottom row: Cancel, then Back to the name step, then "Skip for now" (no type yet).
    --Back keeps any context we already made so it can be cleaned up if the name is changed.
    buttons[#buttons + 1] = {
        {
            text = _("Cancel"),
            callback = function() UIManager:close(dialog) end,
        },
        {
            text = _("\u{2190} Back"),
            callback = function() UIManager:close(dialog); self:createNewContext(title, pos, key) end,
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
function ContextView:showPointsList(key, reveal_all)
    local node = self.store:load().contexts[key]
    if not node then return end

    --(re)build the rows from the CURRENT local doc, so a synced-in edit (e.g. a dot point added on the
    --webapp) can repaint the list in place. by default dot points noted beyond the current reading
    --position are hidden so the notes don't spoil what's ahead (the same persisted setting the all-
    --contexts filter uses); reveal_all is a one-off override (tapping the "hidden" notice).
    local function buildItems()
        local n = self.store:load().contexts[key]
        if not n then return {}, nil end
        local cur = self.store:describeLocator(nil)
        local progress = cur.progress
        local hiding = self:getOnlyRead() and progress ~= nil
        local only_read = hiding and not reveal_all
        local items, later = {}, 0
        for i, point in ipairs(n.points) do
            local beyond = hiding and self:pointBeyond(point, cur)
            if beyond then later = later + 1 end
            if not (only_read and beyond) then
                --dot points are about what you're learning, not bookmarks, so no page shown here
                table.insert(items, {
                    text = BULLET .. ContextSchema.pointText(point):gsub("%s*\n%s*", " "), --collapse multi line points
                    _index = i,
                })
            end
        end
        if later > 0 then
            if reveal_all then
                table.insert(items, { text = T(_("\u{2026} showing %1 later note(s) \u{00B7} tap to hide"), later), _rehide = true })
            else
                table.insert(items, { text = T(_("\u{2026} %1 later note(s) hidden \u{00B7} up to %2% \u{00B7} tap to show"), later, math.floor(progress * 100 + 0.5)), _reveal = true })
            end
        end
        local label = ContextSchema.typeLabel(n.type)
        local bracket = label ~= "" and T(_("(%1 context)"), label) or _("(Unset context type)")
        return items, T(_("%1  \u{00B7} %2"), n.title, bracket)
    end

    local items, title = buildItems()
    local menu, rebuild
    menu = Menu:new{
        title = title,
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false, --keep the border but drop Menus rounded corners
        onMenuSelect = function(_self, item)
            if item._reveal or item._rehide then --flip whether the later notes show, just for this viewing
                UIManager:close(menu)
                self:showPointsList(key, item._reveal == true)
                return
            end
            UIManager:close(menu)
            self:editPoint(key, node.title, item._index)
        end,
        onMenuHold = function(_self, item)
            if item._reveal or item._rehide then return true end
            self:showPointActions(menu, key, item._index)
            return true
        end,
        close_callback = function()
            if self._refresh == rebuild then self._refresh = nil end --stop live-refreshing this closed list
            UIManager:close(menu)
        end,
    }
    --a synced-in change repaints the open list in place (rebuilt from the fresh doc), no close + reopen
    rebuild = function() local it, ti = buildItems(); if ti then menu:switchItemTable(ti, it) end end
    self._refresh = rebuild

    --flank the bottom page-navigation bar: "All contexts" on the left, then this context's
    --relationships and "Add dot point" on the right
    self:addFooterButton(menu, "left", _("\u{2190}"), function()
        UIManager:close(menu)
        self:showAllContexts()
    end)
    self:addFooterButton(menu, "right", _("\u{2194}"), function()
        self:showRelationships(key, menu)
    end)
    self:addFooterButton(menu, "right", _("\u{2248}"), function() --aliases (other names for this context)
        self:showAliases(menu, key)
    end)
    self:addFooterButton(menu, "right", _("\u{FF0B}"), function()
        UIManager:close(menu)
        self:editPoint(key, node.title, nil)
    end)

    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--ask before doing something destructive: pops a Cancel / Delete confirmation, runs on_confirm on Delete.
--guards every deletion so nothing is removed by a single accidental tap.
function ContextView:confirmDelete(text, on_confirm)
    UIManager:show(ConfirmBox:new{
        text = text,
        ok_text = _("Delete"),
        cancel_text = _("Cancel"),
        ok_callback = on_confirm,
    })
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
            self:confirmDelete(_("Delete this dot point?"), function()
                local d = self.store:load()
                local n = d.contexts[key]
                if n then
                    ContextSchema.tombstonePoint(d, n.points[index]) -- so the delete survives a sync
                    table.remove(n.points, index)
                    n.updated = ContextSchema.now()
                    self.store:save(d)
                end
                UIManager:close(menu)
                self:returnToList(key)
            end)
        end,
    }})
    table.insert(buttons, {{
        text = _("Cancel"),
        callback = function() UIManager:close(dialog) end,
    }})

    dialog = ButtonDialog:new{
        title = _("Dot point"),
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
                    if index then
                        ContextSchema.tombstonePoint(doc, points[index]) -- emptied -> delete it (for sync)
                        table.remove(points, index)
                    end
                elseif index then
                    --editing text mints a NEW point id (and tombstones the old) so concurrent edits on two
                    --devices duplicate instead of clobbering. keep the old point's location.
                    local old = points[index]
                    local p = ContextSchema.newPoint(text, {
                        pos = ContextSchema.pointPos(old),
                        progress = type(old) == "table" and old.progress or nil,
                        chapter = type(old) == "table" and old.chapter or nil,
                    })
                    ContextSchema.tombstonePoint(doc, old)
                    points[index] = p
                else
                    --new point, anchored to where it was noted (for jump-back + the timeline)
                    local a = getAnchor()
                    local p = ContextSchema.newPoint(text, a)
                    table.insert(points, p)
                end
                persist()
                UIManager:close(dialog)
                self:returnToList(key)
            end,
        },
    }}
    --while creating a brand new context, let the user set it up without a point yet,
    --or step back to the type picker to change the type they just chose
    if index == nil and allow_skip then
        table.insert(rows, {
            {
                text = _("\u{2190} Back"),
                callback = function()
                    UIManager:close(dialog)
                    self:chooseTypeForNewContext(key, title, pos)
                end,
            },
            {
                text = _("Skip for now"),
                callback = function()
                    ensureNode()        -- keep the freshly created context even with no points
                    self.store:save(doc)
                    UIManager:close(dialog)
                end,
            },
        })
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

    --how far the reader has read (0..1), used by the "only up to here" filter. nil if we can't tell,
    --in which case the filter is unavailable and we just show everything.
    local progress = self.store:describeLocator(nil).progress
    local expanded = {} --type -> true; every type group starts collapsed (tap a header to open it)

    --(re)build the row list for the current "only up to here" filter and collapse state. reloads the doc
    --each call so a synced-in edit repaints the list (counts + new contexts) without a close + reopen.
    local function buildItems()
        local doc = self.store:load()
        local only_read = self:getOnlyRead() and progress ~= nil
        local filter_fn = only_read and function(_key, node)
            local intro = contextIntroProgress(node)
            --keep contexts introduced at or before here; ones with no known spot stay visible (can't place them)
            return intro == nil or intro <= progress + 1e-6
        end or nil
        local items = groupedContextItems(doc, nil, true, filter_fn, expanded)
        --a tappable row at the very top to flip between all contexts and only those up to the reading spot
        if progress ~= nil then
            local pct = math.floor(progress * 100 + 0.5)
            table.insert(items, 1, {
                text = only_read
                    and T(_("\u{25C9} Up to where you've read (%1%) \u{2022} tap to show all"), pct)
                    or T(_("\u{25CB} Showing all \u{2022} tap to show only up to %1%"), pct),
                bold = true,
                _toggle = true,
            })
        end
        return items
    end

    local title = T(_("Contexts: %1"), self.store:getBookTitle())
    local menu, rebuild
    menu = SectionedMenu:new{
        title = title,
        item_table = buildItems(),
        headers_holdable = true, --custom-type headers can be long-pressed to rename
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false, --keep the border but drop Menus rounded corners
        onMenuSelect = function(_self, item)
            if item._toggle then --flip the (persisted) filter and rebuild the list in place
                self:setOnlyRead(not self:getOnlyRead())
                menu:switchItemTable(title, buildItems())
                return
            end
            if item._header then --tap a type header to collapse/expand its dropdown
                expanded[item._type] = (not expanded[item._type]) and true or nil
                menu:switchItemTable(title, buildItems())
                return
            end
            UIManager:close(menu)
            self:openContext(item._key)
        end,
        onMenuHold = function(_self, item)
            if item._toggle then return true end --no actions on the filter row
            if item._header then
                if item._custom_type then self:renameCustomType(item._custom_type, menu) end
                return true
            end
            self:showNodeActions(menu, item._key)
            return true
        end,
        close_callback = function()
            if self._refresh == rebuild then self._refresh = nil end --stop live-refreshing this closed list
            UIManager:close(menu)
        end,
    }
    --a synced-in change (new context / dot point / count) repaints this list in place
    rebuild = function() menu:switchItemTable(title, buildItems()) end
    self._refresh = rebuild

    --a "Relationships" shortcut on the bottom bar once any links exist, opening the book-wide list
    if #doc.relationships > 0 then
        self:addFooterButton(menu, "right", T(_("\u{2194} (%1)"), #doc.relationships), function()
            self:showRelationships(nil, menu)
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
                    self:showRelationships(key, menu)
                end,
            }},
            {{
                text = T(_("Aliases (%1)"), #(node.aliases or {})),
                callback = function()
                    UIManager:close(dialog)
                    self:showAliases(menu, key)
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
                    self:confirmDelete(T(_("Delete the context \u{201C}%1\u{201D} and all its dot points?"), node.title), function()
                        local d = self.store:load()
                        ContextSchema.deleteNode(d, key)
                        self.store:save(d)
                        UIManager:close(menu)
                        self:showAllContexts()
                    end)
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

--rename a node. if the new name normalizes onto an existing node, merge into it (and repoint links),
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
                    elseif doc.contexts[new_key] then
                        --another node already owns this name: merge points into it
                        ContextSchema.mergeNodeInto(doc, key, new_key)
                    else
                        --moves to the new key; re-id's points + tombstones the old key so the old
                        --context doesn't survive on the server as a duplicate after sync
                        ContextSchema.moveNode(doc, key, new_key, new_title)
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


--aliases: extra names a highlighted word can match to this context
--(e.g. "Albus Dumbledore" / "Professor Dumbledore" both resolving to the "Dumbledore" context)

--list a context's aliases. the main name sits at the top with a star, the aliases follow.
--tap an alias to promote/delete it, tap + to add one. parent_menu is the all-contexts list behind us.
function ContextView:showAliases(parent_menu, key)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if not node then return end
    local aliases = node.aliases or {}

    local items = {}
    items[#items + 1] = { text = "\u{2605} " .. node.title, _main = true } --main name, starred, at the top
    for i, alias in ipairs(aliases) do
        items[#items + 1] = { text = BULLET .. alias, _index = i }
    end

    local menu
    menu = Menu:new{
        title = T(_("Aliases for \u{201C}%1\u{201D}"), node.title),
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            if item._main then return end --the starred main name isn't an alias to act on
            self:showAliasActions(menu, parent_menu, key, item._index)
        end,
        onMenuHold = function(_self, item)
            if item._main then return true end
            self:showAliasActions(menu, parent_menu, key, item._index)
            return true
        end,
        close_callback = function() UIManager:close(menu) end,
    }

    --back to the context list, and + to add a new alias
    self:addFooterButton(menu, "left", _("\u{2190}"), function() UIManager:close(menu) end)
    self:addFooterButton(menu, "right", _("\u{FF0B}"), function() self:promptAddAlias(menu, parent_menu, key) end)

    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--act on one alias: make it the context's main name, or delete it
function ContextView:showAliasActions(alias_menu, parent_menu, key, index)
    local doc = self.store:load()
    local node = doc.contexts[key]
    local alias = node and node.aliases and node.aliases[index]
    if not alias then return end

    local dialog
    dialog = ButtonDialog:new{
        title = alias,
        title_align = "center",
        buttons = {
            {{
                text = _("Make main name"),
                callback = function()
                    UIManager:close(dialog)
                    self:promoteAlias(alias_menu, parent_menu, key, index)
                end,
            }},
            {{
                text = _("Delete alias"),
                callback = function()
                    UIManager:close(dialog)
                    self:confirmDelete(T(_("Delete the alias \u{201C}%1\u{201D}?"), alias), function()
                        local d = self.store:load()
                        local n = d.contexts[key]
                        if n and n.aliases then
                            table.remove(n.aliases, index)
                            n.updated = ContextSchema.now()
                            self.store:save(d)
                        end
                        UIManager:close(alias_menu)
                        self:showAliases(parent_menu, key) --refresh the list
                    end)
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

--add `text` as an alias of context `key` (in `doc`, not yet saved), keeping matching unambiguous:
--refuses a name that already resolves to a context. returns true on success, or shows why and
--returns false. the caller saves the doc.
function ContextView:tryAddAlias(doc, key, text)
    text = ContextText.trim(text)
    local node = doc.contexts[key]
    if not node or ContextText.normalizeWord(text) == "" then return false end
    local owner = self:resolveContextKey(doc, text)
    if owner == key then
        UIManager:show(InfoMessage:new{ text = _("That name already matches this context.") })
        return false
    elseif owner then
        UIManager:show(InfoMessage:new{
            text = T(_("\u{201C}%1\u{201D} already matches the context \u{201C}%2\u{201D}."), text, ContextSchema.titleForKey(doc, owner)),
        })
        return false
    end
    node.aliases = node.aliases or {}
    table.insert(node.aliases, text)
    node.updated = ContextSchema.now()
    return true
end

--pick an existing context to attach the highlighted word to as an alias, then open it.
--used from the "open/create context" flows when the word is really another name for a context.
function ContextView:addWordAsAlias(word)
    --the target list is grouped under its type headers (each a collapsible dropdown), like every other
    --context list, so you pick the context to attach this alias to from within its type group.
    self:showContextPicker{
        title = T(_("Add \u{201C}%1\u{201D} as an alias of\u{2026}"), ContextText.trim(word)),
        on_pick = function(menu, key, _title)
            local d = self.store:load()
            if self:tryAddAlias(d, key, word) then
                self.store:save(d)
                UIManager:close(menu)
                self:showPointsList(key) --open the context the word now belongs to
            end
        end,
    }
end

--prompt for a new alias, refusing names that already resolve to a context, then add it
function ContextView:promptAddAlias(alias_menu, parent_menu, key)
    local dialog
    dialog = InputDialog:new{
        title = _("Add alias"),
        input = "",
        input_hint = _("Another name for this context"),
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Add"),
                is_enter_default = true,
                callback = function()
                    local text = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if text == "" then return end
                    local doc = self.store:load()
                    if self:tryAddAlias(doc, key, text) then
                        self.store:save(doc)
                        UIManager:close(alias_menu)
                        self:showAliases(parent_menu, key) --refresh the list
                    end
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--promote an alias to be the context's main name, demoting the old name to an alias.
--changing the name changes the context key (normalizeWord of the title), so we move the node
--just like renameNode does (repointing relationships, tombstoning the old key for sync).
function ContextView:promoteAlias(alias_menu, parent_menu, key, index)
    local doc = self.store:load()
    local node = doc.contexts[key]
    if not node or not node.aliases or not node.aliases[index] then return end

    local new_title = node.aliases[index]
    local old_title = node.title
    local new_key = ContextText.normalizeWord(new_title)
    if new_key == "" then return end

    --can't take over a name another context already owns
    if new_key ~= key and doc.contexts[new_key] then
        UIManager:show(InfoMessage:new{
            text = T(_("A context named \u{201C}%1\u{201D} already exists, so it can't be promoted."), new_title),
        })
        return
    end

    --swap: the alias becomes the title, the old title becomes an alias (unless it's the same key,
    --e.g. a possessive/case variant, in which case the old name still matches without listing it)
    table.remove(node.aliases, index)
    if ContextText.normalizeWord(old_title) ~= new_key then
        table.insert(node.aliases, old_title)
    end

    if new_key ~= key then
        --the key changes, so move the node (re-id'ing points + tombstoning the old key) instead of
        --leaving the old context behind, which would come back as a duplicate after a sync
        ContextSchema.moveNode(doc, key, new_key, new_title)
    else
        node.title = new_title
        node.updated = ContextSchema.now()
    end
    self.store:save(doc)

    --the context's title (and maybe key) changed, so refresh the list behind us too
    UIManager:close(alias_menu)
    if parent_menu then UIManager:close(parent_menu) end
    self:showAllContexts()
end


--relationships

--pick another node to link this one to, then ask for the relationship's label.
--grouped by type like the all-contexts list, with the node we're linking from left out.
function ContextView:showLinkPicker(menu, from_key)
    local doc = self.store:load()
    self:showContextPicker{
        doc = doc,
        title = T(_("Link \u{201C}%1\u{201D} to\u{2026}"), ContextSchema.titleForKey(doc, from_key)),
        exclude_key = from_key,
        empty_text = _("There is no other context to link to yet."),
        on_pick = function(picker, key, _title)
            UIManager:close(picker)
            self:editRelationshipLabel(menu, from_key, key)
        end,
    }
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

--list relationships. key == nil lists every link in the book, otherwise only those touching that node.
function ContextView:showRelationships(key, parent_menu)
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
        --nothing to list: pop the reminder but leave the calling window open behind it
        UIManager:show(InfoMessage:new{
            text = key and _("No relationships for this context yet.\nLong press it and choose \"Link to\u{2026}\" to add one.")
                or _("No relationships in this book yet.\n\nLong-press a context and choose \"Link to\u{2026}\" to add one."),
        })
        return
    end

    --only now that there's a list to show do we close the window we came from
    if parent_menu then UIManager:close(parent_menu) end

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

    --back to where this list opened from: the all-contexts page for the book-wide list,
    --or the context's own points list when scoped to one context
    self:addFooterButton(menu, "left", _("\u{2190}"), function()
        UIManager:close(menu)
        if key then self:showPointsList(key) else self:showAllContexts() end
    end)

    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--a single relationship: its dot points, with footer buttons to rename the link or add a point.
--tap a point to edit it, long-press to delete it (mirrors the node points list).
function ContextView:showRelationshipView(rel_id, reveal_all)
    local doc = self.store:load()
    local rel = ContextSchema.findRel(doc, rel_id)
    if not rel then return end

    --like the context points list, hide link notes from beyond the current reading position by default.
    --reveal_all is a one-off override (tapping the "hidden" notice) and isn't persisted.
    local cur = self.store:describeLocator(nil)
    local progress = cur.progress
    local only_read = self:getOnlyRead() and progress ~= nil and not reveal_all

    local items = {}
    local hidden = 0
    for i, point in ipairs(rel.points) do
        if only_read and self:pointBeyond(point, cur) then
            hidden = hidden + 1
        else
            table.insert(items, {
                text = BULLET .. ContextSchema.pointText(point):gsub("%s*\n%s*", " "),
                _index = i,
            })
        end
    end
    if hidden > 0 then
        table.insert(items, {
            text = T(_("\u{2026} %1 later note(s) hidden \u{00B7} up to %2% \u{00B7} tap to show"), hidden, math.floor(progress * 100 + 0.5)),
            _reveal = true,
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
            if item._reveal then --reveal the later notes, just for this viewing
                UIManager:close(menu)
                self:showRelationshipView(rel_id, true)
                return
            end
            UIManager:close(menu)
            self:editRelPoint(rel_id, item._index)
        end,
        onMenuHold = function(_self, item)
            if item._reveal then return true end
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
                    self:confirmDelete(_("Delete this relationship and its dot points?"), function()
                        local d = self.store:load()
                        local rel, idx = ContextSchema.findRel(d, rel_id)
                        if idx then
                            for _, p in ipairs(rel.points) do ContextSchema.tombstonePoint(d, p) end
                            d.tombstones.relationships[rel_id] = ContextSchema.now()
                            table.remove(d.relationships, idx)
                            self.store:save(d)
                        end
                        UIManager:close(menu)
                        self:showRelationships(list_key)
                    end)
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
                        if index then
                            ContextSchema.tombstonePoint(doc, rel.points[index])
                            table.remove(rel.points, index)
                        end
                    elseif index then
                        --editing text mints a new id + tombstones the old (additive sync), same as node points
                        local old = rel.points[index]
                        ContextSchema.tombstonePoint(doc, old)
                        rel.points[index] = ContextSchema.newPoint(text)
                    else
                        table.insert(rel.points, ContextSchema.newPoint(text))
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
                        ContextSchema.tombstonePoint(doc, rel.points[index]) -- so the delete survives a sync
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


--AI: chapter summaries + "read this chapter, suggest contexts"

--guard: AI must be configured + enabled. shows a hint and returns false if not.
function ContextView:aiReady()
    if self.ai and self.ai:isEnabled() then return true end
    UIManager:show(InfoMessage:new{
        text = _("AI features aren't set up. Open Context Creator \u{2192} AI to pick a provider and enter your API key."),
    })
    return false
end

--show a blocking AI call behind a dismissable "working…" message: paint the message, then (after a
--tick so it actually shows) run the blocking http call, close the message, and hand the result to done.
function ContextView:aiRun(message, work, done)
    local info = InfoMessage:new{ text = message }
    UIManager:show(info)
    UIManager:scheduleIn(0.1, function()
        local ok, res = work()
        UIManager:close(info)
        done(ok, res)
    end)
end

--the locator (xpointer string / { page } table) for a chapter entry from store:getChapterList
function ContextView:chapterLocator(entry)
    if type(entry.pos0) == "string" then return entry.pos0 end
    if type(entry.pos0) == "number" then return { page = entry.pos0 } end
    return nil
end

--a chapter's 0..1 progress, for spoiler-filtering the context block and anchoring applied contexts
function ContextView:chapterProgress(entry)
    local loc = self:chapterLocator(entry)
    if not loc then return nil end
    return self.store:describeLocator(loc).progress
end

--build the compact, spoiler-filtered notes string the AI gets as continuity context, per the
--prior-context setting (none / existing notes / notes + earlier summaries). only includes contexts +
--points introduced at or before `progress`, so a mid-book request can't leak later-book notes.
function ContextView:buildContextBlock(doc, progress, tier)
    tier = tier or ContextAI.PRIOR_NONE
    if tier == ContextAI.PRIOR_NONE then return "" end
    local out = {}

    --earlier chapter summaries first (only the "summaries" tier), in reading order up to here
    if tier == ContextAI.PRIOR_SUMMARIES then
        local toc = doc.book and doc.book.toc
        local sums = doc.book and doc.book.chapter_summaries
        if toc and sums then
            local s = {}
            for _, t in ipairs(toc) do
                if progress == nil or (type(t.progress) == "number" and t.progress <= progress + 1e-6) then
                    local e = sums[ContextText.normalizeWord(t.title)]
                    if e and e.text and e.text ~= "" then s[#s + 1] = t.title .. ": " .. e.text end
                end
            end
            if #s > 0 then out[#out + 1] = "Earlier chapter summaries:\n" .. table.concat(s, "\n") end
        end
    end

    --then existing contexts (spoiler-filtered) as compact one-liners, ordered by where they appear
    local items = {}
    for _, node in pairs(doc.contexts) do
        local intro = contextIntroProgress(node)
        if progress == nil or intro == nil or intro <= progress + 1e-6 then
            items[#items + 1] = { node = node, intro = intro or 0 }
        end
    end
    table.sort(items, function(a, b) return a.intro < b.intro end)
    local note_lines = {}
    for _, it in ipairs(items) do
        local node = it.node
        local pts = {}
        for _, p in ipairs(node.points or {}) do
            local pr = pointProgress(p)
            if progress == nil or pr == nil or pr <= progress + 1e-6 then
                pts[#pts + 1] = ContextSchema.pointText(p)
            end
        end
        local label = ContextSchema.typeLabel(node.type)
        local head = node.title .. (label ~= "" and (" (" .. label .. ")") or "")
        note_lines[#note_lines + 1] = "- " .. head .. (#pts > 0 and (": " .. table.concat(pts, "; ")) or "")
    end
    if #note_lines > 0 then out[#out + 1] = "Known so far:\n" .. table.concat(note_lines, "\n") end

    local block = table.concat(out, "\n\n")
    if #block > 12000 then block = block:sub(1, 12000) end --keep continuity context bounded (cost)
    return block
end

--pick the model from a dropdown built by asking the provider what the current key can use, rather than
--making the user type an id. `after` (optional) runs once a model is chosen (used by the setup wizard).
function ContextView:chooseModel(after)
    local key = self.ai:settings().api_key
    if not key or key == "" then
        UIManager:show(InfoMessage:new{ text = _("Enter your API key first, then pick a model.") })
        return
    end
    self:aiRun(_("Fetching available models\u{2026}"), function()
        return self.ai:listModels()
    end, function(ok, models)
        if not ok then
            UIManager:show(InfoMessage:new{ text = T(_("Couldn't list models: %1"), tostring(models)) })
            return
        end
        if #models == 0 then
            UIManager:show(InfoMessage:new{ text = _("No usable models for this key.") })
            return
        end
        local current = self.ai:getModel()
        local items = {}
        for _mi, id in ipairs(models) do --not `_`: avoid shadowing the gettext `_`
            items[#items + 1] = { text = (id == current) and ("\u{2713} " .. id) or id, _id = id }
        end
        local menu
        menu = Menu:new{
            title = _("Choose a model"),
            item_table = items,
            width = Screen:getWidth() - 2 * WINDOW_MARGIN,
            height = Screen:getHeight() - 2 * WINDOW_MARGIN,
            is_popout = false,
            onMenuSelect = function(_self, item)
                self.ai:set("model", item._id)
                UIManager:close(menu)
                if after then after() end
            end,
            close_callback = function() UIManager:close(menu) end,
        }
        UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
    end)
end

--make sure AI is configured before an action that needs it. if it already is, run `after` straight away;
--otherwise walk a tiny setup wizard (provider -> key -> model) and continue to `after` at the end.
function ContextView:ensureConfigured(after)
    if self.ai:isEnabled() then if after then after() end return end
    self:wizardProvider(after)
end

function ContextView:wizardProvider(after)
    local dialog
    local buttons = {}
    for _pi, pid in ipairs(ContextAI.PROVIDER_ORDER) do --not `_`: avoid shadowing gettext `_`
        local id = pid
        buttons[#buttons + 1] = {{
            text = ContextAI.PROVIDERS[id].label,
            callback = function()
                UIManager:close(dialog)
                self.ai:set("provider", id)
                self:wizardKey(after)
            end,
        }}
    end
    dialog = ButtonDialog:new{ title = _("Choose an AI provider"), title_align = "center", buttons = buttons }
    UIManager:show(dialog)
end

function ContextView:wizardKey(after)
    local prov = ContextAI.PROVIDERS[self.ai:getProvider()]
    local dialog
    dialog = InputDialog:new{
        title = T(_("%1 API key"), (prov and prov.label) or _("Provider")),
        input = self.ai:settings().api_key or "",
        input_hint = _("paste your API key (kept on this device)"),
        text_type = "password",
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Next"),
                is_enter_default = true,
                callback = function()
                    local k = (dialog:getInputText() or ""):gsub("^%s+", ""):gsub("%s+$", "")
                    UIManager:close(dialog)
                    if k == "" then return end
                    self.ai:set("api_key", k)
                    self.ai:set("enabled", true)
                    --let them pick a model from the key, then continue to the original action
                    self:chooseModel(after)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--highlight-popup action: show the current chapter's summary if one exists, otherwise offer to generate
--it (running the setup wizard first if AI isn't configured yet).
function ContextView:chapterSummaryFromHighlight()
    if self.ai:isHidden() then return end
    local entry = self:currentChapterEntry()
    if not entry then
        UIManager:show(InfoMessage:new{ text = _("Couldn't tell which chapter you're in.") })
        return
    end
    if self.store:getChapterSummary(entry.title) then
        self:showChapterSummary(entry.title)
        return
    end
    UIManager:show(ConfirmBox:new{
        text = T(_("No summary yet for \u{201C}%1\u{201D}. Generate one with AI?"), entry.title),
        ok_text = _("Generate"),
        ok_callback = function()
            self:ensureConfigured(function() self:generateSummary(entry) end)
        end,
    })
end

--the chapter picker: a list of the book's chapters, tapping one runs `mode` ("summarize"/"suggest").
function ContextView:showChapterPicker()
    if not self:aiReady() then return end
    local chapters = self.store:getChapterList()
    if not chapters then
        UIManager:show(InfoMessage:new{
            text = _("This book has no chapters the AI can read (no usable table of contents)."),
        })
        return
    end
    local sums = self.store:getBookSummaries()
    local items = {}
    for _ci, ch in ipairs(chapters) do --not `_`: that would shadow the gettext `_` we call below
        local e = sums[ContextText.normalizeWord(ch.title)]
        local suffix = e and (e.source == "user" and _(" \u{2022} edited") or _(" \u{2022} AI")) or ""
        items[#items + 1] = { text = (ch.title or _("(untitled)")) .. suffix, _entry = ch }
    end
    local menu
    menu = Menu:new{
        title = _("Summarize a chapter"),
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            self:chapterSummaryActions(item._entry)
        end,
        close_callback = function() UIManager:close(menu) end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--find the chapter list entry for the chapter the reader is currently in (by matching the TOC title at
--the live position), so the highlight-popup shortcut can act on "this chapter" without a picker.
function ContextView:currentChapterEntry()
    local chapters = self.store:getChapterList()
    if not chapters then return nil end
    local cur = self.store:describeLocator(nil).chapter
    if cur and cur ~= "" then
        for _, ch in ipairs(chapters) do
            if ch.title == cur then return ch end
        end
    end
    return nil
end

--what to do for a chapter the user picked to summarize: straight to generation if there's no summary
--yet, otherwise offer view / edit / regenerate.
function ContextView:chapterSummaryActions(entry)
    if not self.store:getChapterSummary(entry.title) then
        self:generateSummary(entry)
        return
    end
    local dialog
    dialog = ButtonDialog:new{
        title = entry.title,
        title_align = "center",
        buttons = {
            {{ text = _("View summary"), callback = function() UIManager:close(dialog); self:showChapterSummary(entry.title) end }},
            {{ text = _("Edit summary"), callback = function() UIManager:close(dialog); self:editChapterSummary(entry.title) end }},
            {{ text = _("Regenerate with AI"), callback = function() UIManager:close(dialog); self:generateSummary(entry) end }},
            {{ text = _("Cancel"), callback = function() UIManager:close(dialog) end }},
        },
    }
    UIManager:show(dialog)
end

--read the chapter's text, build the continuity context, ask the AI for a summary, store + show it
function ContextView:generateSummary(entry)
    if not self:aiReady() then return end
    local text = self.store:getChapterText(entry.pos0, entry.pos1)
    if not text then
        UIManager:show(InfoMessage:new{ text = _("Couldn't read this chapter's text.") })
        return
    end
    local doc = self.store:load()
    local block = self:buildContextBlock(doc, self:chapterProgress(entry), self.ai:getPriorContext())
    self:aiRun(_("Asking the AI to summarize this chapter\u{2026}"), function()
        return self.ai:summarizeChapter(entry.title, text, block)
    end, function(ok, res)
        if not ok then
            UIManager:show(InfoMessage:new{ text = T(_("AI error: %1"), tostring(res)) })
            return
        end
        self.store:setChapterSummary(entry.title, res, "ai", self.ai:getModel())
        self:refreshOpen()
        self:showChapterSummary(entry.title)
    end)
end

--show a stored chapter summary in a scrollable viewer, with an Edit shortcut
function ContextView:showChapterSummary(chapter_title)
    local entry = self.store:getChapterSummary(chapter_title)
    if not entry then
        UIManager:show(InfoMessage:new{ text = _("No summary for this chapter yet.") })
        return
    end
    local TextViewer = require("ui/widget/textviewer")
    local tag = (entry.source == "user") and _("edited") or _("AI")
    local viewer
    viewer = TextViewer:new{
        title = chapter_title .. " (" .. tag .. ")",
        text = entry.text,
        buttons_table = {{
            { text = _("Edit"), callback = function() UIManager:close(viewer); self:editChapterSummary(chapter_title) end },
            { text = _("Close"), is_enter_default = true, callback = function() UIManager:close(viewer) end },
        }},
    }
    UIManager:show(viewer)
end

--hand-edit a chapter summary (marks it source="user" so it shows as edited and a re-summarize warns)
function ContextView:editChapterSummary(chapter_title)
    local entry = self.store:getChapterSummary(chapter_title)
    local dialog
    dialog = InputDialog:new{
        title = T(_("Edit summary: %1"), chapter_title),
        input = entry and entry.text or "",
        input_hint = _("Chapter summary\u{2026}"),
        allow_newline = true,
        text_height = Screen:scaleBySize(220),
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Save"),
                is_enter_default = true,
                callback = function()
                    local text = ContextText.trim(dialog:getInputText())
                    UIManager:close(dialog)
                    if text == "" then return end
                    self.store:setChapterSummary(chapter_title, text, "user")
                    self:refreshOpen()
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--a viewer-style list of every chapter that has a summary (in reading order), tap to open it
function ContextView:showSummariesList()
    if not (self.ai and not self.ai:isHidden()) then return end
    local doc = self.store:load()
    local sums = doc.book and doc.book.chapter_summaries or {}
    local toc = doc.book and doc.book.toc or {}
    local items, seen = {}, {}
    for _ti, t in ipairs(toc) do --not `_`: that would shadow the gettext `_` we call below
        local key = ContextText.normalizeWord(t.title)
        local e = sums[key]
        if e and not seen[key] then
            seen[key] = true
            local title = t.title
            local tag = (e.source == "user") and _(" \u{2022} edited") or _(" \u{2022} AI")
            items[#items + 1] = { text = title .. tag, _title = title }
        end
    end
    if #items == 0 then
        UIManager:show(InfoMessage:new{ text = _("No chapter summaries yet.") })
        return
    end
    local menu
    menu = Menu:new{
        title = _("Chapter summaries"),
        item_table = items,
        width = Screen:getWidth() - 2 * WINDOW_MARGIN,
        height = Screen:getHeight() - 2 * WINDOW_MARGIN,
        is_popout = false,
        onMenuSelect = function(_self, item) self:showChapterSummary(item._title) end,
        close_callback = function() UIManager:close(menu) end,
    }
    UIManager:show(menu, nil, nil, WINDOW_MARGIN, WINDOW_MARGIN)
end

--ENTRY POINT for the one-click "read the whole book -> build a full profile" feature. confirms setup,
--then warns about the (potentially large) token cost before doing anything.
function ContextView:generateBookProfile()
    if self.ai:isHidden() then return end
    local chapters = self.store:getChapterList()
    if not chapters then
        UIManager:show(InfoMessage:new{ text = _("This book has no chapters the AI can read (no usable table of contents).") })
        return
    end
    self:ensureConfigured(function() self:confirmBookProfile(chapters) end)
end

--the token-cost warning, specific to this feature. the WHOLE book is covered, split into N parts (calls).
function ContextView:confirmBookProfile(chapters)
    local chunks = self.store:getBookChunks()
    if not chunks then
        UIManager:show(InfoMessage:new{ text = _("Couldn't read this book's text.") })
        return
    end
    local total = 0
    for _, c in ipairs(chunks) do total = total + #c.text end
    local ktok = math.floor(total / 4 / 1000 + 0.5) --rough: ~4 chars per token
    local prov = ContextAI.PROVIDERS[self.ai:getProvider()]
    UIManager:show(ConfirmBox:new{
        text = T(_("Read the whole book and build a full AI profile?\n\nThe entire book (~%1k tokens) is sent to %2 across %3 part(s), then a chapter-by-chapter profile (a summary for every chapter plus the plot's characters/places/objects/concepts) is written into a NEW profile, leaving your current notes untouched.\n\n\u{26A0} This can use a large amount of your API quota or paid credits, and may take several minutes. If a part fails it is retried once, then skipped so the rest still go through.\n\nContinue?"),
            ktok, (prov and prov.label) or _("the AI"), #chunks),
        ok_text = _("Continue"),
        ok_callback = function() self:runBookProfile(chapters, chunks) end,
    })
end

--a compact recap of what's been gathered so far, fed to each later chunk so a book processed in parts
--keeps continuity (the AI extends known entries instead of starting fresh each part). bounded for cost.
function ContextView:storySoFar(acc)
    local out = {}
    if #acc.summaries > 0 then
        local s = {}
        for _, su in ipairs(acc.summaries) do s[#s + 1] = su.title .. ": " .. su.text end
        out[#out + 1] = "Chapters summarized so far:\n" .. table.concat(s, "\n")
    end
    if #acc.order > 0 then
        local c = {}
        for _, key in ipairs(acc.order) do
            local node = acc.byKey[key]
            local pts = {}
            for _, p in ipairs(node.points) do pts[#pts + 1] = p.text end
            c[#c + 1] = "- " .. node.title .. " (" .. (node.type or "") .. "): " .. table.concat(pts, "; ")
        end
        out[#out + 1] = "Entries tracked so far:\n" .. table.concat(c, "\n")
    end
    local block = table.concat(out, "\n\n")
    if #block > 16000 then block = block:sub(1, 16000) end --keep the recap bounded as it grows
    return block
end

--merge one chunk's result into the running accumulator (contexts unioned by normalized title, points
--de-duplicated by text; summaries appended in order).
function ContextView:mergeIntoAcc(acc, res)
    for _, c in ipairs(res.contexts or {}) do
        local key = ContextText.normalizeWord(c.title)
        if key ~= "" then
            local node = acc.byKey[key]
            if not node then
                node = { title = c.title, type = c.type, points = {}, seen = {} }
                acc.byKey[key] = node
                acc.order[#acc.order + 1] = key
            end
            if (node.type == nil or node.type == "" or node.type == "unset") and c.type and c.type ~= "unset" then
                node.type = c.type
            end
            for _, pt in ipairs(c.points or {}) do
                if pt.text and not node.seen[pt.text] then
                    node.seen[pt.text] = true
                    node.points[#node.points + 1] = pt
                end
            end
        end
    end
    for _, s in ipairs(res.summaries or {}) do acc.summaries[#acc.summaries + 1] = s end
end

--process the book chunk by chunk (each its own blocking call): show progress, merge the result, retry a
--failed part once, then continue so a single timeout doesn't lose the rest. write the merged profile at the end.
function ContextView:runBookProfile(chapters, chunks)
    local acc = { byKey = {}, order = {}, summaries = {} }
    local failed = 0
    local function finish()
        local res = { contexts = {}, summaries = acc.summaries }
        for _, key in ipairs(acc.order) do res.contexts[#res.contexts + 1] = acc.byKey[key] end
        if #res.contexts == 0 and #res.summaries == 0 then
            UIManager:show(InfoMessage:new{ text = _("The AI didn't return anything usable.") })
            return
        end
        self:writeBookProfile(chapters, res, failed)
    end
    local function step(i, attempt)
        if i > #chunks then finish() return end
        local chunk = chunks[i]
        local msg = (attempt > 1)
            and T(_("Reading the book\u{2026} part %1 of %2 (retry)"), i, #chunks)
            or T(_("Reading the book\u{2026} part %1 of %2"), i, #chunks)
        local story = self:storySoFar(acc)
        self:aiRun(msg, function()
            return self.ai:generateBookProfile(self.store:getBookTitle(), chunk.text, chunk.titles, story)
        end, function(ok, res)
            if ok and res then
                self:mergeIntoAcc(acc, res)
                step(i + 1, 1)
            elseif attempt < 2 then
                step(i, attempt + 1) --retry this part once
            else
                failed = failed + 1
                step(i + 1, 1) --give up on this part, keep going so the rest still go through
            end
        end)
    end
    step(1, 1)
end

--write the AI's result into a brand-new profile: contexts (each point anchored to the chapter it came
--from, so they land on the timeline) plus a book-level summary for every chapter. a fresh profile means
--this never clobbers the user's own notes. chapter summaries that the user hand-edited are preserved.
function ContextView:writeBookProfile(chapters, res, failed)
    --chapter title (normalized) -> timeline anchor { pos, progress, chapter }
    local anchorByChapter = {}
    for _, ch in ipairs(chapters) do
        anchorByChapter[ContextText.normalizeWord(ch.title)] = self.store:describeLocator(self:chapterLocator(ch)) or {}
    end
    local function anchorFor(chapter_title)
        return (chapter_title and anchorByChapter[ContextText.normalizeWord(chapter_title)]) or {}
    end

    --1. a fresh profile, made active, so we never touch the user's existing notes
    self.store:addProfile(T(_("AI: %1"), self.ai:getModel()))
    local doc = self.store:load() --the new, empty profile doc

    --2. contexts, each point anchored to the chapter the AI tied it to
    local ncontexts = 0
    for _, c in ipairs(res.contexts or {}) do
        local key = ContextText.normalizeWord(c.title)
        if key ~= "" and not doc.contexts[key] then
            local node = { title = c.title, type = ContextSchema.resolveType(c.type), points = {}, updated = ContextSchema.now() }
            for _, pt in ipairs(c.points or {}) do
                table.insert(node.points, ContextSchema.newPoint(pt.text, anchorFor(pt.chapter)))
            end
            --anchor the node itself to its earliest point so it sits at the right spot on the timeline
            local minp, minch
            for _, pp in ipairs(node.points) do
                if type(pp.progress) == "number" and (minp == nil or pp.progress < minp) then
                    minp, minch = pp.progress, pp.chapter
                end
            end
            if minp then node.progress = minp; node.chapter = minch end
            doc.contexts[key] = node
            ncontexts = ncontexts + 1
        end
    end
    self.store:save(doc)

    --3. chapter summaries (book-level, shared across profiles) — never overwrite a hand-edited one
    local nsum = 0
    for _, s in ipairs(res.summaries or {}) do
        local existing = self.store:getChapterSummary(s.title)
        if not (existing and existing.source == "user") then
            self.store:setChapterSummary(s.title, s.text, "ai", self.ai:getModel())
            nsum = nsum + 1
        end
    end

    local note = (failed and failed > 0)
        and T(_("\n\n%1 part(s) failed, so this profile may be incomplete."), failed) or ""
    UIManager:show(InfoMessage:new{
        text = T(_("Created a new AI profile with %1 context(s) and %2 chapter summaries.%3"), ncontexts, nsum, note),
    })
    if ncontexts > 0 then self:showAllContexts() end
end

return ContextView
