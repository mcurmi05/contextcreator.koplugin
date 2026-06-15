--[[
the on disk data model and pure operations on a document table

typed contexts, relationships, a stable book id and per entity updated timestamps so device + web
edits can later be merged without clobbering each other (sync server roadmap). everything here is
pure, it just works on plain doc tables and has no KOReader or filesystem dependencies.

doc shape:
  {
    schema = 3,
    book = { id, title, authors, toc = { { title, progress }, ... } },  -- toc: chapter bands for the webapp timeline
    updated = <epoch>,                                  -- file-level last change, for cheap sync checks
    contexts = { [key] = { title, type, points, updated, progress, chapter } },  -- key = normalizeWord(title)
    -- a point is { id, text, pos, progress, chapter }. id is a stable per-point id so the additive sync
    -- merge can union points by id (editing text mints a NEW id + tombstones the old, so concurrent edits
    -- duplicate instead of clobbering). pos is where in the book it was noted (a CRE xpointer string / a
    -- { page = N } table) for on-device jump-back. progress is a 0..1 fraction through the book = the
    -- universal timeline axis the webapp scrubs. chapter is the TOC title there. any of pos/progress/chapter
    -- may be nil. context-level progress/chapter anchor a context that has no located points.
    relationships = { { id, from, to, label, directed, points, updated }, ... },  -- directed=false means no arrow; missing means directed (made before undirected existed)
    tombstones = { contexts = { [key] = <epoch> }, relationships = { [id] = <epoch> }, points = { [id] = <epoch> } },
  }
]]

local ContextSchema = {}

--current on disk schema version
ContextSchema.VERSION = 3

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

--human label for a node type, shown in the lists. built-ins get their nice label, a custom type
--displays under its own name, and unset/empty stays blank so it doesn't clutter
function ContextSchema.typeLabel(t)
    if not t or t == "" or t == "unset" then return "" end
    return TYPE_LABELS[t] or t
end

--a custom type is any non-empty type that isn't unset and isn't one of the built-ins
function ContextSchema.isCustomType(t)
    return t ~= nil and t ~= "" and t ~= "unset" and TYPE_LABELS[t] == nil
end

--turn a user-typed type name into a stored type. if it matches a built-in (by key or label,
--case-insensitively) it folds into that built-in, otherwise it's kept verbatim as a custom type
function ContextSchema.resolveType(name)
    name = (name or ""):gsub("^%s+", ""):gsub("%s+$", "")
    if name == "" then return "unset" end
    local lower = name:lower()
    for key, label in pairs(TYPE_LABELS) do
        if key == lower or label:lower() == lower then return key end
    end
    return name
end

--epoch seconds, stamped on every entity edit so last-write-wins merge has something to compare
function ContextSchema.now() return os.time() end

--unique id for a relationship. no uuid module in koreader, so build one from the clock plus
--randomness (math.randomseed is set once in main:init), collisions are basically impossible for one user
function ContextSchema.genId()
    return string.format("%x-%x-%x", os.time(), math.floor(os.clock() * 1e6) % 0x1000000,
        math.random(0, 0xFFFFFF))
end

--a fresh, empty document
function ContextSchema.newDoc()
    return {
        schema = ContextSchema.VERSION,
        book = {},
        updated = ContextSchema.now(),
        contexts = {},
        relationships = {},
        tombstones = { contexts = {}, relationships = {}, points = {} },
    }
end

--nothing worth keeping: no live contexts, no relationships, and no tombstones to preserve for sync
function ContextSchema.isEmpty(doc)
    if next(doc.contexts) ~= nil then return false end
    if #doc.relationships > 0 then return false end
    if next(doc.tombstones.contexts) ~= nil then return false end
    if next(doc.tombstones.relationships) ~= nil then return false end
    if next(doc.tombstones.points) ~= nil then return false end
    return true
end

--fill in any missing tables/fields so the rest of the code can assume a well-shaped doc
function ContextSchema.normalize(doc)
    doc.schema = ContextSchema.VERSION
    doc.contexts = doc.contexts or {}
    doc.relationships = doc.relationships or {}
    doc.tombstones = doc.tombstones or {}
    doc.tombstones.contexts = doc.tombstones.contexts or {}
    doc.tombstones.relationships = doc.tombstones.relationships or {}
    doc.tombstones.points = doc.tombstones.points or {}
    doc.book = doc.book or {}
    return doc
end

--read a dot point's text. points are { text, pos } tables, but tolerate a bare string (older/imported data)
function ContextSchema.pointText(p)
    if type(p) == "table" then return p.text or "" end
    return p or ""
end

--read a dot point's book locator (xpointer string or { page } table), or nil if not anchored
function ContextSchema.pointPos(p)
    if type(p) == "table" then return p.pos end
    return nil
end

--a point's stable id (nil for legacy bare-string points)
function ContextSchema.pointId(p)
    if type(p) == "table" then return p.id end
    return nil
end

--build a new dot point with a fresh id. anchor (optional) carries { pos, progress, chapter }.
function ContextSchema.newPoint(text, anchor)
    anchor = anchor or {}
    return {
        id = ContextSchema.genId(),
        text = text,
        pos = anchor.pos,
        progress = anchor.progress,
        chapter = anchor.chapter,
    }
end

--record a point's deletion so the additive sync merge won't resurrect it from another device
function ContextSchema.tombstonePoint(doc, point)
    local id = ContextSchema.pointId(point)
    if id then doc.tombstones.points[id] = ContextSchema.now() end
end

--tombstone all of a point list's ids (used when a whole context/relationship is deleted)
local function tombstonePoints(doc, points)
    for _, p in ipairs(points or {}) do
        ContextSchema.tombstonePoint(doc, p)
    end
end

--display title for a context key, falling back to the key itself if the context is gone (defensive)
function ContextSchema.titleForKey(doc, key)
    local context = doc.contexts[key]
    return (context and context.title) or key
end

--find a relationship (and its array index) by id
function ContextSchema.findRel(doc, id)
    for i, rel in ipairs(doc.relationships) do
        if rel.id == id then return rel, i end
    end
    return nil
end

--remove a context and every relationship that touches it, recording tombstones (for the context key,
--its points, and the relationships + their points) so the additive sync merge won't resurrect them
function ContextSchema.deleteNode(doc, key)
    local node = doc.contexts[key]
    if node then
        tombstonePoints(doc, node.points)
        doc.contexts[key] = nil
        doc.tombstones.contexts[key] = ContextSchema.now()
    end
    for i = #doc.relationships, 1, -1 do
        local rel = doc.relationships[i]
        if rel.from == key or rel.to == key then
            tombstonePoints(doc, rel.points)
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
