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
local ContextAI = require("ContextAI")

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
    --bring-your-own-key generative AI (chapter summaries + context suggestions). holds no state itself,
    --reads its config from G_reader_settings on demand, so it's cheap to construct unconditionally.
    self.ai = ContextAI:new()
    self.view = ContextView:new(self.store, self.ai)

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
        --AI shortcuts for the chapter you're reading. show_in_highlight_dialog_func is re-evaluated each
        --time the popup opens, so toggling AI off/hidden drops these without needing to reopen the book.
        --(the dialog builder indexes the returned button directly, so we must return a table, not nil.)
        self.ui.highlight:addToHighlightDialog("17_contextcreator_ai_summary", function(this)
            return {
                text = _("AI: chapter summary"),
                --shown whenever AI isn't hidden (even before setup): tapping opens the chapter's summary if
                --one exists, otherwise offers to generate it (walking setup first if needed).
                show_in_highlight_dialog_func = function() return not self.ai:isHidden() end,
                callback = function()
                    this:onClose()
                    self.view:chapterSummaryFromHighlight()
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
                --always present so a hidden user can always find the unhide toggle; the submenu itself
                --collapses to just that toggle while AI is hidden (see aiMenu).
                text = _("AI"),
                sub_item_table_func = function() return self:aiMenu() end,
            },
            {
                text = _("Sync"),
                sub_item_table_func = function() return self.sync:menu() end,
            },
        },
    }
end

--the "AI" submenu: provider/key/model + how much prior context to send, the summarize/suggest actions,
--and the master hide switch. while hidden it shows only the unhide toggle, so there's always a way back.
function ContextCreator:aiMenu()
    local ai = self.ai
    if ai:isHidden() then
        return {
            {
                text = _("Show AI features"),
                help_text = _("AI features are hidden. Turn this on to bring back the AI menu items and the highlight buttons."),
                checked_func = function() return not ai:isHidden() end,
                callback = function(touchmenu)
                    ai:set("hidden", false)
                    if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                end,
            },
        }
    end

    --provider radio list
    local provider_items = {}
    for _, pid in ipairs(ContextAI.PROVIDER_ORDER) do
        local id = pid
        provider_items[#provider_items + 1] = {
            text = ContextAI.PROVIDERS[id].label,
            checked_func = function() return ai:getProvider() == id end,
            callback = function() ai:set("provider", id) end,
        }
    end

    --how much prior context to include, each with a cost note
    local function priorItem(value, text, help)
        return {
            text = text,
            help_text = help,
            checked_func = function() return ai:getPriorContext() == value end,
            callback = function() ai:set("prior_context", value) end,
        }
    end
    local prior_items = {
        priorItem(ContextAI.PRIOR_NONE, _("None (chapter only)"),
            _("Cheapest. The AI only sees the chosen chapter's text.")),
        priorItem(ContextAI.PRIOR_NOTES, _("Your existing notes"),
            _("Also sends your contexts/notes up to this chapter so the AI can link things. A little more cost.")),
        priorItem(ContextAI.PRIOR_SUMMARIES, _("Notes + earlier summaries"),
            _("Also sends earlier chapter summaries. Best linking, but the most tokens (highest cost and latency).")),
    }

    return {
        {
            text = _("Enable AI features"),
            checked_func = function() return ai:settings().enabled == true end,
            callback = function() ai:set("enabled", not ai:settings().enabled) end,
        },
        {
            text_func = function()
                local p = ContextAI.PROVIDERS[ai:getProvider()]
                return T(_("Provider: %1"), (p and p.label) or ai:getProvider())
            end,
            sub_item_table = provider_items,
        },
        {
            text_func = function()
                local k = ai:settings().api_key
                return (k and k ~= "") and _("API key: set (tap to change)") or _("API key\u{2026}")
            end,
            keep_menu_open = true,
            callback = function(touchmenu) self:promptApiKey(touchmenu) end,
        },
        {
            text_func = function() return T(_("Model: %1"), ai:getModel()) end,
            help_text = _("Pick from the models your key can use (fetched live), instead of typing an id."),
            keep_menu_open = true,
            callback = function(touchmenu)
                self.view:chooseModel(function()
                    if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                end)
            end,
        },
        {
            text = _("Prior context sent to the AI"),
            sub_item_table = prior_items,
            separator = true,
        },
        {
            text = _("Build full profile from book\u{2026}"),
            help_text = _("Reads the whole (finished) book in one pass and writes a new profile: a summary for every chapter plus the plot's characters/places/objects/concepts. Warns about token cost first."),
            keep_menu_open = true,
            callback = function() self.view:generateBookProfile() end,
        },
        {
            text = _("Summarize a chapter\u{2026}"),
            keep_menu_open = true,
            callback = function() self.view:showChapterPicker() end,
        },
        {
            text = _("View chapter summaries\u{2026}"),
            keep_menu_open = true,
            callback = function() self.view:showSummariesList() end,
        },
        {
            text = _("Hide all AI features"),
            separator = true,
            help_text = _("Removes every AI menu item and highlight button. The AI menu keeps a \"Show AI features\" toggle so you can turn it back on."),
            checked_func = function() return ai:isHidden() end,
            callback = function(touchmenu)
                ai:set("hidden", true)
                if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
            end,
        },
    }
end

--enter the provider API key (masked). saving also flips AI on, mirroring how logging in enables sync.
function ContextCreator:promptApiKey(touchmenu)
    local InputDialog = require("ui/widget/inputdialog")
    local dialog
    dialog = InputDialog:new{
        title = _("Provider API key"),
        input = "",
        input_hint = _("paste your API key (kept on this device)"),
        text_type = "password",
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            {
                text = _("Save"),
                is_enter_default = true,
                callback = function()
                    local key = (dialog:getInputText() or ""):gsub("^%s+", ""):gsub("%s+$", "")
                    UIManager:close(dialog)
                    if key ~= "" then
                        self.ai:set("api_key", key)
                        if not self.ai:settings().enabled then self.ai:set("enabled", true) end
                        if touchmenu and touchmenu.updateItems then touchmenu:updateItems() end
                    end
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
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
