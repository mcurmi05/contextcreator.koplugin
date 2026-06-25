--[[
the on disk data model and pure operations on a document table

typed contexts, relationships, a stable book id and per entity updated timestamps so device + web
edits can later be merged without clobbering each other (sync server roadmap). everything here is
pure, it just works on plain doc tables and has no KOReader or filesystem dependencies.

doc shape:
  {
    schema = 4,
    book = { id, title, authors, toc = { { title, progress }, ... }, chapter_summaries = { [chapter_key] = { text, updated, source, model } } },
    -- toc: chapter bands for the webapp timeline. chapter_summaries: BOOK-LEVEL (shared across every
    -- profile of the book, embedded in every export) AI/hand-written per-chapter summaries, keyed by
    -- normalizeWord(chapter title). source is "ai" or "user"; updated stamps each one for sync merge.
    updated = <epoch>,                                  -- file-level last change, for cheap sync checks
    contexts = { [key] = { title, type, points, updated, progress, chapter, aliases } },  -- key = normalizeWord(title)
    -- aliases (optional) is a list of extra display names a highlighted word can match to this context
    -- (e.g. "Albus Dumbledore" / "Professor Dumbledore" all resolving to the "Dumbledore" context)
    -- a point is { id, text, pos, progress, chapter }. id is a stable per-point id so the additive sync
    -- merge can union points by id (editing text mints a NEW id + tombstones the old, so concurrent edits
    -- duplicate instead of clobbering). pos is where in the book it was noted (a CRE xpointer string / a
    -- { page = N } table) for on-device jump-back. progress is a 0..1 fraction through the book = the
    -- universal timeline axis the webapp scrubs. chapter is the TOC title there. any of pos/progress/chapter
    -- may be nil. context-level progress/chapter anchor a context that has no located points.
    relationships = { { id, from, to, label, directed, points, updated }, ... },  -- directed=false means no arrow, missing means directed (made before undirected existed)
    tombstones = { contexts = { [key] = <epoch> }, relationships = { [id] = <epoch> }, points = { [id] = <epoch> } },
  }
]]

local ContextSchema = {}

--current on disk schema version
ContextSchema.VERSION = 4

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

--fill in any missing tables/fields so the rest of the code can assume a well-shaped doc. deliberately
--does NOT touch the schema version — migrate() owns that, so an older doc's version can be read before
--it gets stamped.
function ContextSchema.normalize(doc)
    doc.contexts = doc.contexts or {}
    doc.relationships = doc.relationships or {}
    doc.tombstones = doc.tombstones or {}
    doc.tombstones.contexts = doc.tombstones.contexts or {}
    doc.tombstones.relationships = doc.tombstones.relationships or {}
    doc.tombstones.points = doc.tombstones.points or {}
    doc.book = doc.book or {}
    return doc
end

--bring a doc loaded from disk up to the current schema, then normalise its shape. the schema history so
--far (1..4) only added fields / relaxed shapes that the readers already tolerate (bare-string points,
--missing ids/aliases/`directed`/tombstones — see pointText/ensurePointIds and the merge; v4 added the
--purely additive book.chapter_summaries map), so reaching v4 needs no field rewrites. a FUTURE breaking
--change adds an explicit, idempotent step here, gated on the
--source version, e.g.:
--    if from < 4 then for _, c in pairs(doc.contexts or {}) do ... end end
--a doc written by a NEWER app keeps its own (higher) version and all its unknown fields — lua tables
--preserve them untouched — so opening it on an older build is lossless rather than a silent downgrade.
function ContextSchema.migrate(doc)
    local from = tonumber(doc and doc.schema) or 1
    -- (future per-version migration steps go here, smallest version first)
    ContextSchema.normalize(doc)
    doc.schema = (from > ContextSchema.VERSION) and from or ContextSchema.VERSION
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

--give every point a stable id (and turn any legacy bare-string points into { id, text } tables).
--returns true if anything changed, so the caller can persist the ids once (they must be stable,
--or the same legacy point would get a fresh random id each load and duplicate on sync).
function ContextSchema.ensurePointIds(doc)
    local changed = false
    local function fix(points)
        for i, p in ipairs(points or {}) do
            if type(p) ~= "table" then
                points[i] = { id = ContextSchema.genId(), text = tostring(p) }
                changed = true
            elseif not p.id then
                p.id = ContextSchema.genId()
                changed = true
            end
        end
    end
    for _, context in pairs(doc.contexts) do fix(context.points) end
    for _, rel in ipairs(doc.relationships) do fix(rel.points) end
    return changed
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

--book-level chapter summaries, keyed by an already-normalized chapter key (callers normalize the TOC
--title with ContextText.normalizeWord, kept out of here so this module stays KOReader/dependency-free).
--read a chapter's summary entry { text, updated, source, model }, or nil.
function ContextSchema.getChapterSummary(doc, chapter_key)
    local m = doc.book and doc.book.chapter_summaries
    return m and m[chapter_key] or nil
end

--set/replace a chapter's summary, stamping `updated` so a later last-write-wins merge can compare.
--source is "ai" or "user" (a hand-edit), model (optional) records which model produced an AI one.
function ContextSchema.setChapterSummary(doc, chapter_key, text, source, model)
    doc.book = doc.book or {}
    doc.book.chapter_summaries = doc.book.chapter_summaries or {}
    doc.book.chapter_summaries[chapter_key] = {
        text = text,
        updated = ContextSchema.now(),
        source = source or "ai",
        model = model,
    }
    return doc.book.chapter_summaries[chapter_key]
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

--copy a list of points, giving each a brand new id and tombstoning the original. used when a
--context moves to a new key (rename/promote): the new key gets fresh-id points so the additive sync
--merge can empty out the OLD key (its original points become tombstoned) and then honour the old
--key's context tombstone, instead of the old context lingering on the server and duplicating.
function ContextSchema.reidPoints(doc, points)
    local out = {}
    for _, p in ipairs(points or {}) do
        ContextSchema.tombstonePoint(doc, p)
        local anchor = (type(p) == "table") and { pos = p.pos, progress = p.progress, chapter = p.chapter } or {}
        out[#out + 1] = ContextSchema.newPoint(ContextSchema.pointText(p), anchor)
    end
    return out
end

--move a context to a new key with a new title, carrying its points (re-id'd) and relationships.
--the old key is tombstoned. mirrors how a delete tombstones points, so the old context fully
--disappears on sync rather than surviving (with its old points) as a duplicate of the new one.
function ContextSchema.moveNode(doc, old_key, new_key, new_title)
    local node = doc.contexts[old_key]
    if not node then return end
    node.points = ContextSchema.reidPoints(doc, node.points)
    node.title = new_title
    node.updated = ContextSchema.now()
    doc.contexts[new_key] = node
    ContextSchema.repointRelationships(doc, old_key, new_key)
    doc.contexts[old_key] = nil
    doc.tombstones.contexts[old_key] = ContextSchema.now()
    doc.tombstones.contexts[new_key] = nil
end

--merge a context's points into an existing target context, then tombstone the old key.
--the moved points are re-id'd so the old key empties out on sync (no lingering duplicate).
function ContextSchema.mergeNodeInto(doc, old_key, target_key)
    local node = doc.contexts[old_key]
    local target = doc.contexts[target_key]
    if not node or not target then return end
    for _, p in ipairs(ContextSchema.reidPoints(doc, node.points)) do
        table.insert(target.points, p)
    end
    target.updated = ContextSchema.now()
    ContextSchema.repointRelationships(doc, old_key, target_key)
    doc.contexts[old_key] = nil
    doc.tombstones.contexts[old_key] = ContextSchema.now()
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
