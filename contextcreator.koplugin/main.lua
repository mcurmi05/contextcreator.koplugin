--[[
wires KOReaders hooks (highlight popup, reader menu, dispatcher action) to the UI, plugin split across sibling modules:
  ContextText   - pure text normalization + fuzzy matching
  ContextSchema - the data model and pure operations on a document
  ContextStore  - per book file persistence (load/save)
  ContextView   - all the menus and dialogs
  ContextSync   - seamless device <-> server sync (+ ContextSyncClient http)
]]

local Dispatcher = require("dispatcher")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local _ = require("gettext")
local ContextStore = require("ContextStore")
local ContextView = require("ContextView")
local ContextSync = require("ContextSync")

local ContextCreator = WidgetContainer:extend{
    name = "contextcreator",
    -- only active when a document is open, remove this to also load in the file browser
    is_doc_only = true,
}

--register an action so the context viewer can be bound to a gesture, quick menu, entry or profile
function ContextCreator:onDispatcherRegisterActions()
    Dispatcher:registerAction("contextcreator_show", {
        category = "none",
        event = "ShowContextCreator",
        title = _("Context Creator: view contexts"),
        reader = true,
    })
    Dispatcher:registerAction("contextcreator_sync", {
        category = "none",
        event = "ContextCreatorSync",
        title = _("Context Creator: sync now"),
        reader = true,
    })
end

function ContextCreator:init()
    math.randomseed(os.time() + math.floor(os.clock() * 1e6)) --so ContextSchema.genId() ids differ between sessions
    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)

    --storage + UI for the currently open book
    self.store = ContextStore:new(self.ui)
    self.view = ContextView:new(self.store)

    --seamless sync: push (debounced) after any change, pull on open, flush on close
    self.sync = ContextSync:new(self.store)
    self.store.on_change = function() self.sync:scheduleSync() end
    if self.sync:isConfigured() then
        --pull server changes shortly after the book opens (don't block the open), then keep polling
        --periodically so web/other-device edits show up without a manual sync
        UIManager:scheduleIn(1, function() self.sync:syncNow() end)
        self.sync:startPeriodic()
    end

    --add buttons to the long press/highlight popup
    if self.ui.highlight then
        self.ui.highlight:addToHighlightDialog("13_contextcreator", function(this)
            return {
                text = _("Add to context"),
                callback = function()
                    local sel = this.selected_text
                    local word = sel and sel.text
                    local pos = sel and sel.pos0 -- where in the book this was highlighted
                    this:onClose()
                    if word and word ~= "" then
                        self.view:showEntryEditor(word, pos)
                    end
                end,
            }
        end)
        self.ui.highlight:addToHighlightDialog("14_contextcreator_view", function(this)
            return {
                text = _("View all contexts"),
                callback = function()
                    this:onClose()
                    self.view:showAllContexts()
                end,
            }
        end)
    end
end

function ContextCreator:addToMainMenu(menu_items)
    menu_items.contextcreator = {
        text = _("Context Creator"),
        sorting_hint = "navi", --first/navigation tab
        sub_item_table = {
            {
                text = _("View all contexts"),
                callback = function() self.view:showAllContexts() end,
            },
            {
                text = _("Sync"),
                sub_item_table_func = function() return self.sync:menu() end,
            },
        },
    }
end

--dispatched by the registered contextcreator_show action
function ContextCreator:onShowContextCreator()
    self.view:showAllContexts()
    return true
end

--dispatched by the registered contextcreator_sync action (gesture/profile-bindable manual sync)
function ContextCreator:onContextCreatorSync()
    if self.sync then self.sync:syncNow(true) end
    return true
end

--stop polling and flush any pending sync when the book closes
function ContextCreator:onCloseDocument()
    if self.sync then
        self.sync:stopPeriodic()
        self.sync:flush()
    end
end

return ContextCreator
