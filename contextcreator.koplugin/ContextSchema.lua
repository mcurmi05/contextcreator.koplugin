--[[
the v2 on disk data model and pure operations on a document table

v1 was the flat { "<title>": ["point", ...] } shape. v2 adds typed nodes, relationships, a
stable book id and per entity updated timestamps so device + web edits can later be merged
without clobbering each other (sync server roadmap). everything here is pure, it just works on
plain doc tables and has no KOReader or filesystem dependencies

doc shape:
  {
    schema = 2,
    book = { id, title, authors },
    updated = <epoch>,                                  -- file-level last change, for cheap sync checks
    nodes = { [key] = { title, type, points, updated } },  -- key = ContextText.normalizeWord(title)
    relationships = { { id, from, to, label, directed, points, updated }, ... },  -- directed=false means no arrow; missing means directed (made before undirected existed)
    tombstones = { nodes = { [key] = <epoch> }, relationships = { [id] = <epoch> } },
  }
]]

local ContextText = require("ContextText")

local ContextSchema = {}

--current on disk schema version
ContextSchema.VERSION = 2

--the kinds of thing a node can be. "unset" is the default until the user picks one.
--the keys are stored on disk (and synced), the labels are just what we show the user, so we can
--display "place" as "Location" without touching saved data
ContextSchema.NODE_TYPES = { "character", "place", "object", "concept", "unset" }
local TYPE_LABELS = {
    character = "Character",
    place = "Location",
    object = "Object",
    concept = "Concept",
}

--human label for a node type, shown in the lists (unset/unknown stays blank so it doesn't clutter)
function ContextSchema.typeLabel(t)
    return TYPE_LABELS[t] or ""
end

--epoch seconds, stamped on every entity edit so last-write-wins merge has something to compare
function ContextSchema.now() return os.time() end

--unique id for a relationship. no uuid module in koreader, so build one from the clock plus
--randomness (math.randomseed is set once in main:init), collisions are basically impossible for one user
function ContextSchema.genId()
    return string.format("%x-%x-%x", os.time(), math.floor(os.clock() * 1e6) % 0x1000000,
        math.random(0, 0xFFFFFF))
end

--a fresh, empty v2 document
function ContextSchema.newDoc()
    return {
        schema = ContextSchema.VERSION,
        book = {},
        updated = ContextSchema.now(),
        nodes = {},
        relationships = {},
        tombstones = { nodes = {}, relationships = {} },
    }
end

--nothing worth keeping: no live nodes, no relationships, and no tombstones to preserve for sync
function ContextSchema.isEmpty(doc)
    if next(doc.nodes) ~= nil then return false end
    if #doc.relationships > 0 then return false end
    if next(doc.tombstones.nodes) ~= nil then return false end
    if next(doc.tombstones.relationships) ~= nil then return false end
    return true
end

--fill in any missing tables/fields so the rest of the code can assume a well-shaped doc
function ContextSchema.normalize(doc)
    doc.schema = ContextSchema.VERSION
    doc.nodes = doc.nodes or {}
    doc.relationships = doc.relationships or {}
    doc.tombstones = doc.tombstones or {}
    doc.tombstones.nodes = doc.tombstones.nodes or {}
    doc.tombstones.relationships = doc.tombstones.relationships or {}
    doc.book = doc.book or {}
    return doc
end

--convert an old flat v1 file ({ "<title>": ["point", ...] }) into a v2 document.
--every title becomes an "unset" node, no relationships. non-destructive, runs on load.
function ContextSchema.migrateV1toV2(data)
    local doc = ContextSchema.newDoc()
    for title, points in pairs(data) do
        if type(points) == "table" then
            local key = ContextText.normalizeWord(title)
            if key ~= "" then
                local node = doc.nodes[key]
                if node then
                    --two old titles normalize to the same key: fold their points together
                    for _, p in ipairs(points) do table.insert(node.points, p) end
                else
                    doc.nodes[key] = { title = title, type = "unset", points = points, updated = ContextSchema.now() }
                end
            end
        end
    end
    return doc
end

--display title for a node key, falling back to the key itself if the node is gone (defensive)
function ContextSchema.titleForKey(doc, key)
    local node = doc.nodes[key]
    return (node and node.title) or key
end

--find a relationship (and its array index) by id
function ContextSchema.findRel(doc, id)
    for i, rel in ipairs(doc.relationships) do
        if rel.id == id then return rel, i end
    end
    return nil
end

--remove a node and every relationship that touches it, recording tombstones so the deletes
--survive a future sync (last-write-wins won't resurrect them)
function ContextSchema.deleteNode(doc, key)
    if doc.nodes[key] then
        doc.nodes[key] = nil
        doc.tombstones.nodes[key] = ContextSchema.now()
    end
    for i = #doc.relationships, 1, -1 do
        local rel = doc.relationships[i]
        if rel.from == key or rel.to == key then
            doc.tombstones.relationships[rel.id] = ContextSchema.now()
            table.remove(doc.relationships, i)
        end
    end
end

--move every relationship endpoint from old_key to new_key (used when a rename changes the node id).
--a link that collapses onto itself (from == to) is dropped.
function ContextSchema.repointRelationships(doc, old_key, new_key)
    for i = #doc.relationships, 1, -1 do
        local rel = doc.relationships[i]
        local changed = false
        if rel.from == old_key then rel.from = new_key; changed = true end
        if rel.to == old_key then rel.to = new_key; changed = true end
        if rel.from == rel.to then
            doc.tombstones.relationships[rel.id] = ContextSchema.now()
            table.remove(doc.relationships, i)
        elseif changed then
            rel.updated = ContextSchema.now()
        end
    end
end

return ContextSchema
