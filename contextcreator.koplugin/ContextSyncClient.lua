--[[
thin http client for the sync server. sends the device bearer token, talks json, and uses
socketutil timeouts so a slow/dead server can't hang the reader for long. http and https both work.
modeled on koreaders own kosync client, just simpler (socket.http + ltn12 instead of Spore).
]]

local http = require("socket.http")
local ltn12 = require("ltn12")
local socketutil = require("socketutil")
local rapidjson = require("rapidjson")
local logger = require("logger")

--block timeout / total timeout (seconds) — short so a dead server fails fast
local BLOCK_TIMEOUT = 10
local TOTAL_TIMEOUT = 30

local ContextSyncClient = {}
ContextSyncClient.__index = ContextSyncClient

function ContextSyncClient:new(server, token)
    return setmetatable({ server = (server or ""):gsub("/+$", ""), token = token or "" }, ContextSyncClient)
end

--make a request, returns (ok, decoded_response_or_error). body is an optional lua table (sent as json).
function ContextSyncClient:request(method, path, body)
    local url = self.server .. path
    local headers = {
        ["Authorization"] = "Bearer " .. self.token,
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
    local _, code = requester.request{
        url = url,
        method = method,
        headers = headers,
        source = source,
        sink = ltn12.sink.table(sink),
    }
    socketutil:reset_timeout()

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

--push the device's whole doc; server merges and returns the merged doc to adopt locally
function ContextSyncClient:pushBook(book_id, doc)
    return self:request("POST", "/api/sync/books/" .. book_id, doc)
end

--pull the server's authoritative doc for a book (not used by the seamless flow, handy for debugging)
function ContextSyncClient:pullBook(book_id)
    return self:request("GET", "/api/sync/books/" .. book_id)
end

return ContextSyncClient
