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
local T = require("ffi/util").template
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
    --when a sync pulls in a remote change (e.g. a dot point added on the webapp), repaint the open list
    self.sync.on_synced = function() self.view:refreshOpen() end
    if self.sync:isConfigured() then
        --pull server changes shortly after the book opens (don't block the open), then keep polling
        --periodically so web/other-device edits show up without a manual sync
        UIManager:scheduleIn(1, function() self.sync:syncNow() end)
        --learn this book's profiles (incl. any made on the web) so the picker is current
        UIManager:scheduleIn(2, function() self.sync:syncProfiles() end)
        --report the device's book catalog so the web ui can start contexts for un-noted books
        UIManager:scheduleIn(3, function() self.sync:syncLibrary() end)
        --once per app session, do a full library scan (covers + unopened books too), deferred a bit more so
        --it doesn't compete with opening the book. self-guards against re-running on every book open.
        self.sync:syncAllBooksOnStartup()
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
        self.ui.highlight:addToHighlightDialog("15_contextcreator_open", function(this)
            return {
                text = _("Open context"),
                callback = function()
                    local sel = this.selected_text
                    local word = sel and sel.text
                    local pos = sel and sel.pos0 -- carried so a new context's first point can be anchored
                    this:onClose()
                    if word and word ~= "" then
                        self.view:openMatchingContext(word, pos)
                    end
                end,
            }
        end)
        self.ui.highlight:addToHighlightDialog("16_contextcreator_alias", function(this)
            return {
                text = _("Add as alias"),
                callback = function()
                    local sel = this.selected_text
                    local word = sel and sel.text
                    this:onClose()
                    if word and word ~= "" then
                        self.view:addWordAsAlias(word)
                    end
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
                text_func = function()
                    return T(_("Profile: %1"), self.store:getProfileName(self.store:getProfileId()))
                end,
                sub_item_table_func = function() return self:profilesMenu() end,
            },
            {
                text = _("Sync"),
                sub_item_table_func = function() return self.sync:menu() end,
            },
        },
    }
end

--the "Profile" submenu: pick which of the book's context docs to read/write here (independent of the
--web's choice), or make a new one. switching reloads the view and syncs so its contents come down.
function ContextCreator:profilesMenu()
    local items = {}
    for _, p in ipairs(self.store:getProfileList()) do
        local id, name = p.id, p.name
        items[#items + 1] = {
            --text_func (not a static string) so a rename refreshes live on the next updateItems()
            text_func = function() return self.store:getProfileName(id) end,
            checked_func = function() return self.store:getProfileId() == id end,
            callback = function(touchmenu)
                self.store:setProfileId(id)
                if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                if self.sync then self.sync:syncNow() end --pull this profile's contents down
                self.view:showAllContexts()
            end,
            --long-press a profile to rename or delete it (both sync to the web + other devices).
            --pass only the id; the name is read fresh from the store so a previous rename is reflected.
            hold_callback = function(touchmenu) self:profileActions(touchmenu, id) end,
        }
    end
    items[#items + 1] = {
        text = _("New profile\u{2026}"),
        keep_menu_open = true,
        separator = true,
        callback = function(touchmenu) self:promptNewProfile(touchmenu) end,
    }
    return items
end

--long-press actions on a profile: rename or delete it. shown as a small button dialog. the name is
--read fresh from the store (not captured at menu-build time) so it reflects a previous rename.
function ContextCreator:profileActions(touchmenu, id)
    local ButtonDialog = require("ui/widget/buttondialog")
    local name = self.store:getProfileName(id)
    local dialog
    dialog = ButtonDialog:new{
        title = T(_("Profile: %1"), name),
        title_align = "center",
        buttons = {
            {{ text = _("Rename\u{2026}"), callback = function() UIManager:close(dialog); self:promptRenameProfile(touchmenu, id) end }},
            {{ text = _("Delete"), callback = function() UIManager:close(dialog); self:confirmDeleteProfile(touchmenu, id) end }},
            {{ text = _("Cancel"), callback = function() UIManager:close(dialog) end }},
        },
    }
    UIManager:show(dialog)
end

--rename a profile locally and push the new name to the server (so the web + other devices pick it up)
function ContextCreator:promptRenameProfile(touchmenu, id)
    local InputDialog = require("ui/widget/inputdialog")
    local name = self.store:getProfileName(id) --current name, so the input prefills with the latest
    local dialog
    dialog = InputDialog:new{
        title = _("Rename profile"),
        input = name,
        input_hint = _("profile name"),
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Rename"),
                is_enter_default = true,
                callback = function()
                    local newname = dialog:getInputText()
                    UIManager:close(dialog)
                    if newname and newname ~= "" and newname ~= name then
                        self.store:renameProfile(id, newname)
                        if self.sync then self.sync:renameProfileRemote(id, newname) end
                        if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                    end
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--delete a profile locally (after confirming) and on the server, so the web + other devices drop it too
function ContextCreator:confirmDeleteProfile(touchmenu, id)
    local ConfirmBox = require("ui/widget/confirmbox")
    local name = self.store:getProfileName(id)
    UIManager:show(ConfirmBox:new{
        text = T(_("Delete profile \u{201C}%1\u{201D}? Its notes are removed and can't be recovered."), name),
        ok_text = _("Delete"),
        ok_callback = function()
            self.store:removeProfile(id)
            if self.sync then self.sync:deleteProfileRemote(id) end
            if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
        end,
    })
end

--prompt for a new profile name, create it locally (made active) and sync so the server registers it
function ContextCreator:promptNewProfile(touchmenu)
    local InputDialog = require("ui/widget/inputdialog")
    local dialog
    dialog = InputDialog:new{
        title = _("New profile"),
        input_hint = _("profile name"),
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Create"),
                is_enter_default = true,
                callback = function()
                    local name = dialog:getInputText()
                    UIManager:close(dialog)
                    if name and name ~= "" then
                        self.store:addProfile(name)
                        if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                        if self.sync then self.sync:syncNow() end
                        self.view:showAllContexts()
                    end
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
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

--koreader broadcasts this when a book's metadata or cover changes (e.g. the user sets a custom cover or
--edits the title). while a book is open that's the current book, so re-sync just it, right away.
function ContextCreator:onBookMetadataChanged()
    if self.sync and self.store then
        local file = self.store:getBookFile()
        UIManager:scheduleIn(0.1, function() self.sync:syncBookMeta(file) end) --let the event finish first
    end
end

--stop polling and flush any pending sync when the book closes
function ContextCreator:onCloseDocument()
    if self.sync then
        self.sync:stopPeriodic()
        self.sync:flush()
    end
end

return ContextCreator
