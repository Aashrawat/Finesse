# MCP integration in the existing Finesse app

Finesse keeps its existing FastAPI endpoints, React UI, accounts, Free/Pro plans, file attachments,
image generation, spoken replies, streaming responses, and conversation history. Shared knowledge-base
ingestion and retrieval remain disabled. Tool results are used for the current turn; final answers and
source links are saved with their conversation, without creating a document index.

## 1. Review and architecture

The integration attaches to the existing path:

```text
POST /api/chat                       api/kb.py: validates the account, plan and selected model
  -> stream_chat                     core/kb/chat.py: existing files, images, history and streaming
  -> agent runner                    core/agent/runner.py: model-directed multi-tool loop
  -> OpenAI Responses                core/agent/providers.py: tool definitions and tool-result round trips
  -> MCP client                      core/agent/client.py: discovery, allowlists, deadlines and call limits
  -> authenticated HTTP /mcp/         core/agent/server.py: official SDK FastMCP server
  -> Google / Wikipedia              core/agent/web_tools.py: fixed-origin, read-only API adapters
```

The best default for this Hugging Face Docker Space is a **co-located HTTP MCP server mounted inside
FastAPI**. It uses the Space's existing port, process and Dockerfile. The FastAPI lifespan explicitly
starts the MCP session manager; merely mounting its ASGI app is insufficient. The backend connects
through loopback, while a browser continues to use `/api/chat`. Users never choose tools manually.

Separate MCP servers are useful later when tools need independent scaling, credentials, or ownership.
Configured remote Streamable HTTP servers are supported, with explicit user/tool allowlists and read-only
annotations. Do not accept MCP URLs or credentials from a chat message.

The official SDK's **supported FastMCP 1.x line** is pinned to `mcp>=1.30,<2`. SDK 2.x is a breaking
upgrade with a different server interface; the upper bound prevents an accidental deployment migration.
This uses `mcp.server.fastmcp.FastMCP`, `ClientSession`, and `streamable_http_client` from the official SDK.

## 2. Dependencies

The MCP dependencies in `requirements.txt` are `mcp`, `httpx`, `PyJWT`, and `tzdata`.
OpenAI's SDK minimum covers Responses streaming. MCP does not need SQL drivers. The app's existing
account storage continues to use `pymongo` independently of MCP.

For this Windows workspace with uv:

```powershell
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
```

An environment with pip can instead run `python -m pip install -r requirements.txt`. Hugging Face's
existing Dockerfile installs requirements when the Space rebuilds. No additional public port is needed.

## 3. Secrets and optional services

Add the settings you need from the table below to your local `.env`. On Hugging Face, use
**Space Settings → Variables and secrets**. Store API keys and signing secrets as Secrets.
Do not put credentials in frontend `VITE_*` settings, Git, tool descriptions, or chat messages.

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Existing OpenAI reasoning, document/vision helpers, image and speech features |
| `SERPAPI_API_KEY` | Enables Google Search; Wikipedia is not a substitute for missing live-news search |
| `WIKIMEDIA_USER_AGENT` | Optional descriptive bot User-Agent with a real contact URL/email; defaults to the public app URL or Finesse project URL |
| `MCP_AUTH_SECRET` | Long random signing secret; otherwise a random process-local secret is generated |
| `APP_URL` | Your public app URL, for example `https://YOUR-SPACE.hf.space` |
| `MCP_INTERNAL_PORT` | Local 8000; Docker sets 7860. Hosting `PORT` takes precedence |
| `MCP_INTERNAL_URL` | Optional exact internal MCP URL if a custom local port is used; include `/mcp/` |
| `MCP_ENABLED` | Default `true`; set `false` to use the existing tool-free OpenAI path |

Use a long random signing secret, for example generate one locally with
`python -c "import secrets; print(secrets.token_urlsafe(48))"` and save it directly to Secrets.
Use one uvicorn worker, as required by the existing job system. Multiple workers would also need a shared
`MCP_AUTH_SECRET`. Do not run the secret-generation command in a shared log or paste its output into chat.

On Hugging Face keep loopback HTTP for the internal connection. The public app uses HTTPS. The MCP endpoint
requires short-lived, signed, audience-bound backend credentials. Ordinary app users cannot mint these tokens.
The endpoint permits localhost hosts by default. If you deliberately expose it to a trusted external service,
set `MCP_ALLOWED_HOSTS` to the exact external hostname and implement that service's credential provisioning.
This first-party service authentication is not a public OAuth authorization service.

Chat reasoning and the existing image, speech, OCR and history-summary helpers use OpenAI. No keys are
required for MCP discovery itself or Wikipedia. Only Google Search and Wikipedia are supported;
GitHub and database integrations have been removed for now.

## 4. Automatic model/tool loop

`core/agent/providers.py` converts the existing conversation, including supported image attachments, for
OpenAI Responses function calling with `store=False`. Text streams through the existing SSE endpoint. Models decide between a direct
answer and the discovered tools. The backend executes tool calls and returns their results before asking for
the next model response. It supports more than one tool and more than one round.

The search policy distinguishes changing information from stable knowledge:

| Information | Example | Default behavior |
| --- | --- | --- |
| Latest news or match results | Who won yesterday's football match? | Google Search; identify the match and date |
| Current facts | Which club does Ronaldo play for now? | Google Search |
| Prices | Bitcoin price today | Google Search; include the source's timestamp if available |
| Weather | Weather in Toronto today | Google Search; verify the location and forecast date |
| Recent or ongoing statistics | Ronaldo's total goals in 2026 | Google Search; verify the reporting period |
| Historical facts | When was R9 born? | Answer directly when confident |
| Basic knowledge | What is artificial intelligence? | Answer directly |
| Programming concepts | What is Redis caching? | Answer directly; search for current releases or API changes |
| Mathematics | What is 25 x 40? | Answer directly |
| Creative writing | Write a poem about football | Answer directly |
| Personal recommendations | Which programming language should I learn? | Usually answer directly; search when current information matters |

Wikipedia is used for stable facts when verification, uncertainty, an explicit Wikipedia search, or requested
sources make it useful. Explicit search requests are honored even for simple facts. Explicit requests not to
search are honored without claiming that remembered information is current. Google results are sourced
reports, not a guaranteed real-time market or weather feed; missing current facts are not invented.
Tool selection remains model-directed using the system policy and tool descriptions.

Defaults: eight calls, five tool rounds plus a final answer, 15 seconds per tool and 180 seconds per turn.
`MCP_MAX_TOOL_CALLS`, `MCP_MAX_ROUNDS`, `MCP_TOOL_TIMEOUT`, and `MCP_TURN_TIMEOUT` adjust these within code limits.
The existing completion-token budget is shared across agent rounds. At the limit, tools are disabled for the
final answer. A failed tool returns an explicit error rather than invented data. Service and provider outages
do not authorize new tools or credentials.

Tool results remain untrusted reference data, never system instructions. Prompts explicitly reject embedded
instructions, but hard controls provide the actual boundaries: no code execution, no model-supplied URLs,
fixed public API origins, authenticated MCP calls, no write tools, and a Google/Wikipedia tool allowlist. After a
non-public remote tool is read, public tool calls stay blocked for the rest of that
conversation to prevent a model from sending private results to a search engine, including on a later turn.
Necessary public research must happen first, or in a separate chat. Private conversations are bound to the
account that read the data; another login or a logged-out browser cannot list, reopen, continue or delete
them. Access restrictions on older private database conversations remain intact for compatibility;
legacy access settings do not register tools, open connections, or grant database MCP scopes.

Audit logs contain user ID, tool name, success and duration, without arguments, results, tokens or connection
strings. HTTP request logs that could include SerpAPI query-string credentials are suppressed. The existing
conversation/request logging policy still applies to messages and final answers; tool results are not added
to a knowledge base. Source URL cards are separate from conversation attachment citations.

No mutation tools or general-purpose HTTP, shell, or SQL proxies are exposed. A model cannot add tools
or grant itself access to other services.

## 5. Optional trusted remote MCP servers

Optional trusted remote servers are also restricted to `google_search` and `wikipedia_search`.
An old remote configuration cannot re-enable removed GitHub or database tools. To configure a trusted
search service, set `MCP_REMOTE_SERVERS_JSON`:

```json
[
  {
    "name": "company",
    "url": "https://trusted.example/mcp",
    "token_env": "COMPANY_MCP_READ_TOKEN",
    "allowed_user_ids": ["ACTUAL_ACCOUNT_ID"],
    "tools": ["wikipedia_search"]
  }
]
```

The token is read from a Secret. Only listed, supported tools with `readOnlyHint=true` and no destructive hint are
exposed. A remote server must be trusted by the operator; tool annotations alone are not a security guarantee.
Use `public=true` only for tools whose results and service credential may safely be shared across all users.
Otherwise results are treated as private and trigger the same public-egress restriction. HTTP is permitted
only for explicitly configured loopback hosts; other remote URLs must use HTTPS. No redirects are followed.

## 6. Run and test

Start the existing app as before, after installing requirements and configuring the needed services:

```powershell
.\.venv\Scripts\python.exe -m uvicorn api.main:app --reload --port 8000
```

In another terminal, `cd frontend` and `npm.cmd run dev`. Open `http://localhost:5173`.

Read diagnostics without revealing keys:

```powershell
Invoke-RestMethod http://localhost:8000/api/agent/status
Invoke-RestMethod http://localhost:8000/api/agent/tools
```

The status endpoint reports Google Search and Wikipedia configuration. The tool list contains only supported,
authorized search tools. If local MCP is unavailable, confirm the internal port and `/mcp/`
trailing slash, then check that the FastAPI lifespan starts the MCP session manager. Missing service keys are
shown as configuration booleans, not secret values.

`google_search: true` means a key is present and MCP is enabled; it does not validate that key. SerpAPI
returns HTTP 401 for an invalid API key and HTTP 429 for exhausted search quota or throughput limits.
If the chatbot cannot search Google, run `scripts/check_mcp.py --probe-google` to check the real search
through MCP without an OpenAI call. The probe uses one SerpAPI search request and returns a nonzero exit
code on failure. Correct `SERPAPI_API_KEY` using your SerpAPI account's key, then restart the backend
(or update the Hugging Face Secret and restart the Space). Tavily and OpenAI keys cannot replace this key.
Earlier assistant claims about unavailable search do not determine tool access on the next turn.

If Wikipedia returns HTTP 403, inspect the `external_service_failed` log entry. Wikimedia requires a meaningful
User-Agent with contact information and may block generic automated clients. The Wikipedia tool supplies one
automatically. Set `WIKIMEDIA_USER_AGENT` to identify your deployed app and operator if needed, then restart the
backend. Do not impersonate a browser or repeatedly retry a policy denial. An HTTP 429 indicates a rate limit;
wait before trying again. Errors retain safe status codes without including credentials or upstream bodies.

Run the self-contained real HTTP protocol check without a running backend:

```powershell
.\.venv\Scripts\python.exe scripts/check_mcp.py
.\.venv\Scripts\python.exe scripts/check_mcp.py --probe
.\.venv\Scripts\python.exe scripts/check_mcp.py --probe-google
```

`--probe` (also available as `--probe-wikipedia`) makes one public Wikipedia search. To test actual model selection and tool use, supply a question; this
uses your provider's configured API key and is billed by that provider, without saving a test conversation:

```powershell
.\.venv\Scripts\python.exe scripts/check_mcp.py --question "Search Google for recent space exploration news and cite sources."
.\.venv\Scripts\python.exe scripts/check_mcp.py --question "Who was Albert Einstein? Include a source I can read."
```

Try these through the normal chat UI:

| Question | Expected behavior |
| --- | --- |
| What is Python? | Answer directly; no tool execution required |
| What happened in AI today? | Google Search, if SerpAPI is configured; cite returned sources |
| Who was Albert Einstein? Include sources. | Wikipedia when verification is useful |
| Read a repository file or query business records. | Explain that these MCP integrations are unavailable |
| Modify an external resource. | No mutation tool is available; no action executes |

Run automated checks:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
cd frontend
npm.cmd run typecheck
npm.cmd run build
```

The suite includes actual MCP HTTP authentication, discovery and execution with mocked service responses;
OpenAI tool loops; tool-call/time limits; rejection of removed tools, including direct MCP calls;
private-data egress blocking; and the previous chat, plan, attachment and knowledge-base restrictions.
Paid provider calls are not exercised by the automated suite.

## Official references

- [MCP SDK FastMCP maintenance line and version policy](https://github.com/modelcontextprotocol/python-sdk/tree/v1.x)
- [Mounting MCP inside an existing ASGI app](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/asgi.md)
- [OpenAI Responses function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [SerpAPI Google Search](https://serpapi.com/search-api)
- [MediaWiki search API](https://www.mediawiki.org/wiki/API:Search)
