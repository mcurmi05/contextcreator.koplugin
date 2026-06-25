--[[
generative-AI helper: per-chapter summaries and "read this chapter, suggest contexts" proposals.

the user brings their own provider account/key (Anthropic / OpenAI / Gemini); the device calls the
provider's HTTP API directly (hybrid model — no sync server needed for AI). settings (provider, key,
model, how much prior context to send, and the master enable/hide switches) live in G_reader_settings
under "contextcreator_ai", mirroring how ContextSync stores its own settings.

this module is deliberately UI-free and KOReader-widget-free: it only does settings + blocking HTTP +
prompt building + response parsing. the calling code (ContextView) owns the dialogs and the "working…"
message. the HTTP calls block (like ContextSyncClient) but use long timeouts for LLM latency.
]]

local http = require("socket.http")
local ltn12 = require("ltn12")
local socketutil = require("socketutil")
local rapidjson = require("rapidjson")
local logger = require("logger")

--LLMs are slow, so allow much longer than the sync client's 10/30s before giving up
local BLOCK_TIMEOUT = 60
local TOTAL_TIMEOUT = 120

local ContextAI = {}
ContextAI.__index = ContextAI

--known providers, their default (editable) model, and how to build a request / read a reply. each
--builder returns (url, headers, body_table); each parser pulls the assistant's text out of the decoded
--json response. keeping this table-driven means adding a provider later is just one more entry.
ContextAI.PROVIDERS = {
    anthropic = {
        label = "Claude (Anthropic)",
        default_model = "claude-haiku-4-5-20251001",
        build = function(key, model, system, prompt, max_tokens, json) --json: anthropic has no strict mode, the tolerant parser handles it
            return "https://api.anthropic.com/v1/messages",
                {
                    ["x-api-key"] = key,
                    ["anthropic-version"] = "2023-06-01",
                },
                {
                    model = model,
                    max_tokens = max_tokens,
                    system = system,
                    messages = { { role = "user", content = prompt } },
                }
        end,
        parse = function(d)
            local c = d and d.content
            if type(c) == "table" and c[1] and c[1].text then return c[1].text end
            return nil
        end,
        --GET that lists the models this key can use, and how to read the ids out of the reply
        list = function(key)
            return "https://api.anthropic.com/v1/models?limit=100",
                { ["x-api-key"] = key, ["anthropic-version"] = "2023-06-01" }
        end,
        parse_models = function(d)
            local out = {}
            for _di, m in ipairs((d and d.data) or {}) do
                if m.id then out[#out + 1] = m.id end
            end
            return out
        end,
    },
    openai = {
        label = "OpenAI (ChatGPT)",
        default_model = "gpt-4o-mini",
        build = function(key, model, system, prompt, max_tokens, json)
            local body = {
                model = model,
                max_tokens = max_tokens,
                messages = {
                    { role = "system", content = system },
                    { role = "user", content = prompt },
                },
            }
            if json then body.response_format = { type = "json_object" } end --force valid json output
            return "https://api.openai.com/v1/chat/completions",
                { ["Authorization"] = "Bearer " .. key }, body
        end,
        parse = function(d)
            local ch = d and d.choices
            if type(ch) == "table" and ch[1] and ch[1].message and ch[1].message.content then
                return ch[1].message.content
            end
            return nil
        end,
        list = function(key)
            return "https://api.openai.com/v1/models", { ["Authorization"] = "Bearer " .. key }
        end,
        parse_models = function(d)
            local out = {}
            for _di, m in ipairs((d and d.data) or {}) do
                if m.id then out[#out + 1] = m.id end
            end
            table.sort(out)
            return out
        end,
    },
    gemini = {
        label = "Gemini (Google)",
        --model ids change over time (the 1.5 names were retired); the AI menu's "Model…" field overrides
        --this, and `curl .../v1beta/models?key=...` lists what a given key actually supports.
        default_model = "gemini-2.5-flash",
        build = function(key, model, system, prompt, max_tokens, json)
            local gen = { maxOutputTokens = max_tokens }
            if json then gen.responseMimeType = "application/json" end --force clean json (no fences/prose)
            return "https://generativelanguage.googleapis.com/v1beta/models/" .. model
                    .. ":generateContent?key=" .. key,
                {},
                {
                    systemInstruction = { parts = { { text = system } } },
                    contents = { { parts = { { text = prompt } } } },
                    generationConfig = gen,
                }
        end,
        parse = function(d)
            local cand = d and d.candidates and d.candidates[1]
            if cand and cand.content and cand.content.parts then
                --concatenate every text part (json mode can split the object across parts)
                local buf = {}
                for _pi, part in ipairs(cand.content.parts) do
                    if type(part.text) == "string" then buf[#buf + 1] = part.text end
                end
                if #buf > 0 then return table.concat(buf) end
            end
            --no text: surface why (safety block, or the reply was cut off by the token limit)
            local reason = cand and cand.finishReason
            local block = d and d.promptFeedback and d.promptFeedback.blockReason
            if block then return nil, "blocked: " .. tostring(block) end
            if reason and reason ~= "STOP" then return nil, "stopped: " .. tostring(reason) end
            return nil
        end,
        list = function(key)
            return "https://generativelanguage.googleapis.com/v1beta/models?key=" .. key .. "&pageSize=200", {}
        end,
        parse_models = function(d)
            local out = {}
            for _di, m in ipairs((d and d.models) or {}) do
                --only models that actually support generateContent (the method we call), name is "models/<id>"
                local methods = m.supportedGenerationMethods or {}
                local ok = false
                for _mi, meth in ipairs(methods) do if meth == "generateContent" then ok = true break end end
                if ok and m.name then out[#out + 1] = (m.name:gsub("^models/", "")) end
            end
            return out
        end,
    },
}

--display order for the provider picker
ContextAI.PROVIDER_ORDER = { "anthropic", "openai", "gemini" }

--how much prior context to fold into a prompt (cost grows down the list). consumed by ContextView,
--which builds the actual text; kept here so the setting's allowed values live with the rest of the AI config.
ContextAI.PRIOR_NONE = "none"
ContextAI.PRIOR_NOTES = "notes"
ContextAI.PRIOR_SUMMARIES = "summaries"

function ContextAI:new()
    return setmetatable({}, ContextAI)
end

function ContextAI:settings()
    return G_reader_settings:readSetting("contextcreator_ai") or {}
end

function ContextAI:saveSettings(s)
    G_reader_settings:saveSetting("contextcreator_ai", s)
end

--a single setting field updated in place (read-modify-write so we never clobber the others)
function ContextAI:set(field, value)
    local s = self:settings()
    s[field] = value
    self:saveSettings(s)
end

--AI features are usable only when explicitly enabled, an api key is set, and not hidden. the provider
--always resolves (getProvider defaults to anthropic), so a key alone is enough to get going.
function ContextAI:isEnabled()
    local s = self:settings()
    return s.enabled == true and not s.hidden
        and s.api_key ~= nil and s.api_key ~= ""
end

--the master "remove all AI UI" switch. when on, nothing AI-related is shown anywhere.
function ContextAI:isHidden()
    return self:settings().hidden == true
end

function ContextAI:getProvider()
    return self:settings().provider or "anthropic"
end

--the model to use: the user's override, else the provider's default
function ContextAI:getModel()
    local s = self:settings()
    if s.model and s.model ~= "" then return s.model end
    local p = ContextAI.PROVIDERS[s.provider or "anthropic"]
    return p and p.default_model or ""
end

function ContextAI:getPriorContext()
    return self:settings().prior_context or ContextAI.PRIOR_NOTES
end

--make a blocking request to a provider, returns (true, decoded_table) or (false, error_string).
--body (optional table) makes it a POST with a json body, else a GET. modeled on ContextSyncClient:request:
--pcall-guarded so a tls/socket error fails gracefully instead of crashing the reader, timeout always reset.
local function httpRequest(url, headers, body)
    headers = headers or {}
    headers["Accept"] = "application/json"
    local source
    if body ~= nil then
        local encoded = rapidjson.encode(body)
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = tostring(#encoded)
        source = ltn12.source.string(encoded)
    end

    local sink = {}
    local requester = http
    if url:match("^https://") then
        local ok, https = pcall(require, "ssl.https")
        if ok then requester = https end
    end

    socketutil:set_timeout(BLOCK_TIMEOUT, TOTAL_TIMEOUT)
    local ok, _, code = pcall(requester.request, {
        url = url,
        method = body ~= nil and "POST" or "GET",
        headers = headers,
        source = source,
        sink = ltn12.sink.table(sink),
    })
    socketutil:reset_timeout()

    if not ok then
        logger.warn("ContextCreator AI: request error:", tostring(_))
        return false, "request error"
    end
    local resp = table.concat(sink)
    if type(code) ~= "number" or code < 200 or code >= 300 then
        logger.warn("ContextCreator AI: HTTP", tostring(code), resp:sub(1, 300))
        --surface the provider's own error message when it sends one (bad key, bad model, rate limit…)
        local okd, d = pcall(rapidjson.decode, resp)
        local msg = okd and type(d) == "table" and d.error and (d.error.message or d.error) or nil
        return false, msg and tostring(msg) or ("HTTP " .. tostring(code))
    end
    local okd, decoded = pcall(rapidjson.decode, resp)
    if not okd or type(decoded) ~= "table" then return false, "bad response" end
    return true, decoded
end

--list the models the configured key can use (for the model picker). returns (true, { ids }) or (false, err).
function ContextAI:listModels()
    local s = self:settings()
    local prov = ContextAI.PROVIDERS[self:getProvider()]
    if not prov or not prov.list then return false, "listing not supported for this provider" end
    if not s.api_key or s.api_key == "" then return false, "no API key set" end
    local url, headers = prov.list(s.api_key)
    local ok, decoded = httpRequest(url, headers)
    if not ok then return false, decoded end
    local models = prov.parse_models(decoded) or {}
    return true, models
end

--run one completion against the configured provider. json=true asks the provider for structured JSON
--output where it supports it. returns (true, assistant_text) or (false, err).
function ContextAI:complete(system, prompt, max_tokens, json)
    local s = self:settings()
    local prov = ContextAI.PROVIDERS[self:getProvider()]
    if not prov then return false, "no AI provider configured" end
    if not s.api_key or s.api_key == "" then return false, "no API key set" end
    local url, headers, body = prov.build(s.api_key, self:getModel(), system, prompt, max_tokens or 1024, json)
    local ok, decoded = httpRequest(url, headers, body)
    if not ok then return false, decoded end
    local text, reason = prov.parse(decoded)
    if not text or text == "" then return false, reason or "empty response" end
    return true, text
end

local SYSTEM = "You are a careful literary assistant helping a reader build a per-book reference of "
    .. "characters, locations, objects and concepts as they read. Use ONLY the chapter text and the "
    .. "reader's existing notes provided. Never reveal or rely on events from later in the book or from "
    .. "outside knowledge. Be concise and concrete."

--summarize a single chapter. context_block is an optional compact, spoiler-filtered string of the
--reader's existing notes / prior summaries (built by the caller per the prior-context setting).
--returns (true, summary_text) or (false, err).
function ContextAI:summarizeChapter(chapter_title, chapter_text, context_block)
    local parts = {}
    if context_block and context_block ~= "" then
        parts[#parts + 1] = "The reader's existing notes so far (for continuity — do not just repeat them):\n"
            .. context_block .. "\n"
    end
    parts[#parts + 1] = "Summarize this chapter in 4-8 sentences. Focus on what happens and what it reveals "
        .. "about the characters and world. Do not include anything beyond this chapter.\n\n"
        .. "Chapter: " .. (chapter_title or "(untitled)") .. "\n\n" .. chapter_text
    --2048 (not ~300 a summary needs) leaves headroom for Gemini 2.5's "thinking", which eats the budget
    return self:complete(SYSTEM, table.concat(parts), 2048)
end

--strip a model reply down to the JSON object it (hopefully) contains: models often wrap JSON in prose
--or ```json fences, so take everything between the first { and the last }.
local function extractJson(text)
    local a = text:find("{", 1, true)
    local b = text:find("}[^}]*$")
    if not a or not b or b < a then return nil end
    return text:sub(a, b)
end

--decode a model reply into a table, trying the raw text first then the {...} carved out of any prose/fences.
--returns the decoded table or nil.
local function decodeReply(text)
    for _, candidate in ipairs({ text, extractJson(text) }) do
        if candidate then
            local okd, d = pcall(rapidjson.decode, candidate)
            if okd and type(d) == "table" then return d end
        end
    end
    return nil
end

local BOOK_SYSTEM = "You are a literary assistant building a complete reference for a book the reader has "
    .. "FINISHED. You may use the whole book. Be concise, concrete, and focus on what actually matters to "
    .. "the plot — skip incidental, one-off mentions."

--read a section of a (finished) book and produce part of a profile: a short summary for every chapter in
--this section plus the plot-relevant contexts (characters/places/objects/concepts), each dot point tagged
--with the chapter it's established in. section_text is "## <chapter title>" headers; chapter_titles is the
--ordered titles in THIS section (so the model tags points with exact titles). story_so_far (optional) is a
--compact recap of earlier sections so a long book processed in chunks keeps continuity. returns (true, {
--  contexts = { { title, type, points = { { text, chapter }, ... } }, ... },
--  summaries = { { title, text }, ... } }) or (false, err).
function ContextAI:generateBookProfile(book_title, section_text, chapter_titles, story_so_far)
    local parts = {}
    local whole = (story_so_far == nil or story_so_far == "")
    parts[#parts + 1] = whole
        and "Below is the full text of a finished book, split into chapters by \"## <chapter title>\" headers. Do TWO things:\n"
        or  "Below is the NEXT section of a finished book you're working through, split into chapters by \"## <chapter title>\" headers. Using the recap of earlier sections, do TWO things:\n"
    parts[#parts + 1] = "1. For EVERY chapter shown below, write a 1-3 sentence summary of what happens in it.\n"
        .. "2. List the entries worth tracking (important characters, locations, objects, concepts) that appear "
        .. "in this section. Give each 2-6 short factual dot points, and tag every point with the chapter title "
        .. "where that information is established. Extend entries already known from the recap (reuse their exact "
        .. "title) rather than repeating their existing points.\n"
    if chapter_titles and #chapter_titles > 0 then
        parts[#parts + 1] = "Use these EXACT chapter titles (for both summaries and point tags): "
            .. table.concat(chapter_titles, " | ") .. "\n"
    end
    if not whole then
        parts[#parts + 1] = "\nRecap of earlier sections:\n" .. story_so_far .. "\n"
    end
    parts[#parts + 1] = "\nReply with ONLY a JSON object, no prose, of this exact shape:\n"
        .. '{"summaries":[{"title":"Chapter title","text":"summary"}],'
        .. '"contexts":[{"title":"Name","type":"character|place|object|concept",'
        .. '"points":[{"text":"fact","chapter":"Chapter title"}]}]}\n\n'
        .. "Book: " .. (book_title or "(untitled)") .. "\n\n" .. section_text
    --big output budget (a summary per chapter + many contexts) and json mode for clean structured output
    local ok, text = self:complete(BOOK_SYSTEM, table.concat(parts), 16384, true)
    if not ok then return false, text end

    local decoded = decodeReply(text)
    if type(decoded) ~= "table" or (type(decoded.contexts) ~= "table" and type(decoded.summaries) ~= "table") then
        local snippet = (text or ""):gsub("%s+", " "):sub(1, 90)
        logger.warn("ContextCreator AI: unparseable book profile:", (text or ""):sub(1, 400))
        return false, "AI didn't return usable JSON \u{2014} got: " .. snippet
    end

    --normalize contexts: { title, type, points = { { text, chapter } } }
    local contexts = {}
    for _, c in ipairs(decoded.contexts or {}) do
        if type(c) == "table" and type(c.title) == "string" and c.title ~= "" then
            local points = {}
            for _, p in ipairs(c.points or {}) do
                if type(p) == "table" and type(p.text) == "string" and p.text ~= "" then
                    points[#points + 1] = { text = p.text, chapter = (type(p.chapter) == "string") and p.chapter or nil }
                elseif type(p) == "string" and p ~= "" then
                    points[#points + 1] = { text = p }
                end
            end
            contexts[#contexts + 1] = { title = c.title, type = (type(c.type) == "string") and c.type or "unset", points = points }
        end
    end

    --normalize summaries: { { title, text } }
    local summaries = {}
    for _, sct in ipairs(decoded.summaries or {}) do
        if type(sct) == "table" and type(sct.title) == "string" and sct.title ~= ""
                and type(sct.text) == "string" and sct.text ~= "" then
            summaries[#summaries + 1] = { title = sct.title, text = sct.text }
        end
    end

    return true, { contexts = contexts, summaries = summaries }
end

return ContextAI
