// The plugin end to end against a local stand-in for Amazon Quick: sign-in
// through the callback port, chat (plain, streamed, with tools), renewal and
// a refused sign-in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import plugin, { _internal } from "../index.mjs"
import { startMock } from "./mock-upstream.mjs"

let mock
let hooks
let auth
const saved = []

beforeAll(async () => {
  mock = startMock()
  const client = { auth: { set: async ({ body }) => void saved.push(body) } }
  hooks = await plugin.server(
    { client, directory: "/tmp" },
    { oidc_base: mock.url, discovery_url: mock.url + "/sn", data_plane_url: mock.url, callback_port: 0, request_timeout: "10s" },
  )
})

afterAll(() => {
  mock.stop()
  _internal.oauth.setEndpoints()
})

// Follows the sign-in the way a browser does.
async function browse(url) {
  for (let hops = 0; hops < 10; hops++) {
    const res = await fetch(url, { redirect: "manual" })
    if (res.status !== 302) return res
    url = res.headers.get("location")
  }
  throw new Error("too many redirects")
}

const post = async (body, init = {}) => {
  const { fetch: send, baseURL } = await hooks.auth.loader(async () => auth)
  return send(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify(body), ...init })
}

async function sse(res) {
  const events = []
  for (const line of (await res.text()).split("\n")) if (line.startsWith("data: ") && line !== "data: [DONE]") events.push(JSON.parse(line.slice(6)))
  return events
}

describe("sign-in", () => {
  test("the provider is declared with Amazon Quick's four modes", async () => {
    const config = {}
    await hooks.config(config)
    expect(config.provider["aws-quick"].npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(config.provider["aws-quick"].models)).toEqual(["smart", "fast", "balanced", "auto"])
  })

  test("browser sign-in saves the account", async () => {
    const method = hooks.auth.methods[0]
    const started = await method.authorize({ provider: "social" })
    expect(started.method).toBe("auto")
    const port = new URL(started.url).port
    expect(started.url).toBe(`http://127.0.0.1:${port}/start?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`)
    expect(started.instructions).toContain(`${mock.url}/sn?qwSurface=desktop%3A`)

    // an address that isn't this sign-in's is told so, and the sign-in waits on
    expect((await fetch(`http://127.0.0.1:${port}/callback?nonce=wrong`)).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404)

    const page = await browse(started.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("ada@example.com is signed in")

    auth = await started.callback()
    expect(auth).toMatchObject({
      type: "success",
      accountId: "ada@example.com",
      access: "access-0",
      refresh: "refresh-0",
      quickProvider: "social",
      clientId: "mock-client",
      wsHost: mock.url.replace("http://", "ws://"),
      actorArn: "arn:aws:quicksight:us-east-1:123456789012:user/default/ada",
      tokenEndpoint: mock.url + "/token",
    })
    expect(auth.expires).toBeGreaterThan(Date.now() + 3000_000)
    auth = { ...auth, type: "oauth" }
  })

  test("a second sign-in ends the one left waiting", async () => {
    const method = hooks.auth.methods[0]
    const first = await method.authorize({ provider: "social" })
    const second = await method.authorize({ provider: "social" })
    expect(await first.callback()).toEqual({ type: "failed", error: "another sign-in to Amazon Quick was started" })
    const abort = new AbortController()
    const waiting = second.callback(undefined, { signal: abort.signal })
    abort.abort()
    expect((await waiting).type).toBe("failed")
  })
})

describe("chat", () => {
  test("a plain completion", async () => {
    const res = await post({ model: "aws-quick/fast", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "ping" }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "pong from fast" }, finish_reason: "stop" })
    expect(body.usage).toEqual({ prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } })

    const turn = mock.state.turns.at(-1)
    expect(turn).toMatchObject({ text: "ping", agent_mode: "fast", send_origin: "programmatic", appVersion: "1.2.4660", user_timezone: "UTC" })
    expect(turn.system_prompt).toStartWith("Be brief.\n\nBackend prompt override:")
    expect(turn.thinking_effort).toBeUndefined()
    // the conversation is taken out of Amazon Quick's chat list again
    await Bun.sleep(50)
    expect(mock.state.deleted).toContain(turn.thread_id)
  })

  test("a streamed completion", async () => {
    const res = await post({ model: "smart", stream: true, stream_options: { include_usage: true }, reasoning_effort: "high", messages: [{ role: "user", content: "ping" }] })
    expect(res.headers.get("content-type")).toStartWith("text/event-stream")
    const events = await sse(res)
    expect(events[0].choices[0].delta).toEqual({ role: "assistant" })
    expect(events.map((e) => e.choices[0]?.delta?.content ?? "").join("")).toBe("pong from smart")
    expect(events.at(-2).choices[0].finish_reason).toBe("stop")
    expect(events.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 20 } })
    expect(mock.state.turns.at(-1).thinking_effort).toBe("high")
  })

  const tools = [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }]

  test("a client tool call, streamed: the text arrives, the marker becomes a call", async () => {
    const events = await sse(await post({ model: "smart", stream: true, tools, messages: [{ role: "user", content: "Please use the tool get_weather" }] }))
    expect(events.map((e) => e.choices[0].delta.content ?? "").join("")).toBe("Let me check. ")
    const call = events.find((e) => e.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0]
    expect(call).toMatchObject({ index: 0, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } })
    expect(call.id).toStartWith("call_")
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls")
    expect(mock.state.turns.at(-1).system_prompt).toContain('"name": "get_weather"')
  })

  test("a client tool call, not streamed, and its result on the next turn", async () => {
    const first = await (await post({ model: "smart", tools, messages: [{ role: "user", content: "Please use the tool get_weather" }] })).json()
    expect(first.choices[0].finish_reason).toBe("tool_calls")
    const call = first.choices[0].message.tool_calls[0]
    expect(call.function).toEqual({ name: "get_weather", arguments: '{"city":"Paris"}' })

    await post({
      model: "smart",
      tools,
      messages: [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "18°C" },
      ],
    })
    expect(mock.state.turns.at(-1).text).toBe(
      `User: weather in Paris?\n\nAssistant tool call (id=${call.id}, name=get_weather): {"city":"Paris"}\n\nTool result (call_id=${call.id}, name=get_weather): 18°C`,
    )
  })

  test("tool_choice none turns the bridge off", async () => {
    const body = await (await post({ model: "smart", tools, tool_choice: "none", messages: [{ role: "user", content: "Please use the tool get_weather" }] })).json()
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "pong from smart" })
    expect(mock.state.turns.at(-1).system_prompt).not.toContain("<client_tool_protocol>")
  })

  test("an error event before any text is a status magpie can act on", async () => {
    mock.state.script = () => [{ type: "turn_failed", payload: { message: "ThrottlingException: Too many requests" } }]
    const res = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] })
    expect(res.status).toBe(429)
    expect((await res.json()).error.message).toContain("Too many requests")
    mock.state.script = () => [{ type: "error", payload: { message: "internal failure" } }]
    expect((await post({ model: "smart", messages: [{ role: "user", content: "ping" }] })).status).toBe(502)
    mock.state.script = () => [{ type: "text_delta", payload: "half" }, { type: "stream_error", payload: { message: "cut" } }]
    const events = await sse(await post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] }))
    expect(events.at(-1).error.message).toContain("cut")
    mock.state.script = null
  })

  test("bad requests and other paths", async () => {
    expect((await post({ model: "smart", messages: [] })).status).toBe(400)
    const { fetch: send, baseURL } = await hooks.auth.loader(async () => auth)
    expect((await send(`${baseURL}/responses`, { method: "POST", body: "{}" })).status).toBe(404)
    expect((await (await send(`${baseURL}/models`, { method: "GET" })).json()).data.map((m) => m.id)).toEqual(["smart", "fast", "balanced", "auto"])
  })

  test("a cancelled request ends the upstream turn", async () => {
    mock.state.script = () => []
    const abort = new AbortController()
    const pending = post({ model: "smart", messages: [{ role: "user", content: "ping" }] }, { signal: abort.signal })
    setTimeout(() => abort.abort(), 50)
    await expect(pending).rejects.toThrow()
    await pending.catch(() => {})
    mock.state.script = null
  })
})

describe("renewal", () => {
  test("magpie's refresh hook returns the renewed fields", async () => {
    const next = await hooks.auth.refresh(auth)
    expect(next).toMatchObject({ access: "access-1", refresh: "refresh-1", accountId: "ada@example.com", clientId: "mock-client" })
    expect(next.expires).toBeGreaterThan(Date.now())
  })

  test("a refused refresh token asks for a new sign-in", async () => {
    await expect(hooks.auth.refresh({ ...auth, refresh: "revoked" })).rejects.toMatchObject({ signIn: "expired" })
    await expect(hooks.auth.refresh({ ...auth, refresh: "none" })).rejects.toMatchObject({ signIn: "expired" })
  })

  test("without the hook (OpenCode), an expired token is renewed once and saved", async () => {
    const before = mock.state.refreshes
    const old = { ...auth, expires: Date.now() - 1000 }
    const { fetch: send, baseURL } = await hooks.auth.loader(async () => old)
    const ask = () => send(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "ping" }] }) })
    const [a, b] = await Promise.all([ask(), ask()])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(mock.state.refreshes).toBe(before + 1)
    expect(saved.at(-1)).toMatchObject({ type: "oauth", access: `access-${before + 1}`, accountId: "ada@example.com" })
  })

  test("Amazon Quick refusing the token marks the account", async () => {
    mock.state.rejectToken = auth.idToken
    const res = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] })
    expect(res.status).toBe(401)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    mock.state.rejectToken = ""
  })
})
