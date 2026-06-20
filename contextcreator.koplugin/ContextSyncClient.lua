--[[
thin http client for the sync server. authenticates with the account's username + password via HTTP
Basic auth (same idea as kosync), talks json, and uses socketutil timeouts so a slow/dead server
can't hang the reader for long. http and https both work.
]]

local http = require("socket.http")
local ltn12 = require("ltn12")
local mime = require("mime")
local socketutil = require("socketutil")
local rapidjson = require("rapidjson")
local logger = require("logger")

--block timeout / total timeout (seconds), short so a dead server fails fast
local BLOCK_TIMEOUT = 10
local TOTAL_TIMEOUT = 30

local ContextSyncClient = {}
ContextSyncClient.__index = ContextSyncClient

function ContextSyncClient:new(server, username, password)
    --normalize the server url: drop surrounding whitespace + trailing slashes, and default a missing
    --scheme to http://. without a scheme koreader's url parser mistakes the host for the scheme, which
    --crashes deep in socket.http (SCHEMES lookup), so guard against a bare "host:port" being entered.
    server = (server or ""):gsub("%s+", "")
    if server ~= "" and not server:match("^https?://") then
        server = "http://" .. server
    end
    return setmetatable({
        server = server:gsub("/+$", ""),
        auth = "Basic " .. mime.b64((username or "") .. ":" .. (password or "")),
    }, ContextSyncClient)
end

--make a request, returns (ok, decoded_response_or_error). body is an optional lua table (sent as json).
function ContextSyncClient:request(method, path, body)
    local url = self.server .. path
    local headers = {
        ["Authorization"] = self.auth,
        ["Accept"] = "application/json",
    }
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
    --pcall the request so a bad url, tls handshake failure or other socket error returns a graceful
    --failure instead of bubbling up an error that crashes the whole reader. reset the timeout either way.
    local ok, _, code = pcall(requester.request, {
        url = url,
        method = method,
        headers = headers,
        source = source,
        sink = ltn12.sink.table(sink),
    })
    socketutil:reset_timeout()

    if not ok then
        logger.warn("ContextCreator sync:", method, path, "request error:", tostring(_))
        return false, "request error"
    end
    if type(code) ~= "number" or code < 200 or code >= 300 then
        logger.warn("ContextCreator sync:", method, path, "->", tostring(code))
        return false, code
    end

    local resp = table.concat(sink)
    if resp == "" then return true, {} end
    local ok, decoded = pcall(rapidjson.decode, resp)
    if not ok then return false, "bad json from server" end
    return true, decoded
end

--url-encode a profile name for the query string (spaces, punctuation etc)
local function urlencode(s)
    return (tostring(s or ""):gsub("[^%w%-_%.~]", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

--push the device's whole doc for one profile; server merges and returns the merged doc to adopt locally.
--name (optional) registers/updates the profile's display name server-side (used when it's brand new).
--device (optional) is { id, name } so the server can track this device's reading position separately,
--letting the web "jump to current" offer every connected device's spot.
function ContextSyncClient:pushBook(book_id, doc, profile, name, device)
    local q = "?profile=" .. urlencode(profile or "default")
    if name and name ~= "" then q = q .. "&name=" .. urlencode(name) end
    if device and device.id and device.id ~= "" then
        q = q .. "&device_id=" .. urlencode(device.id)
        if device.name and device.name ~= "" then q = q .. "&device_name=" .. urlencode(device.name) end
        if device.chapter and device.chapter ~= "" then q = q .. "&device_chapter=" .. urlencode(device.chapter) end
        if type(device.chapter_frac) == "number" then
            q = q .. "&device_chapter_frac=" .. urlencode(string.format("%.6f", device.chapter_frac))
        end
    end
    return self:request("POST", "/api/sync/books/" .. book_id .. q, doc)
end

--pull the server's authoritative doc for one profile (not used by the seamless flow, handy for debugging)
function ContextSyncClient:pullBook(book_id, profile)
    return self:request("GET", "/api/sync/books/" .. book_id .. "?profile=" .. urlencode(profile or "default"))
end

--the named profiles the server knows for a book, so the device picker can show them (and learn ones
--made on the web). returns a list of { profile_id, name, updated }.
function ContextSyncClient:listProfiles(book_id)
    return self:request("GET", "/api/sync/books/" .. book_id .. "/profiles")
end

--report the device's book catalog (a list of { book_id, title, authors, cover? }) so the web ui can
--offer to start contexts for books that have no notes yet, and show cover art. cover is a data: url,
--sent only the first time a book is seen.
function ContextSyncClient:pushLibrary(books)
    return self:request("POST", "/api/sync/library", rapidjson.array(books))
end

return ContextSyncClient
