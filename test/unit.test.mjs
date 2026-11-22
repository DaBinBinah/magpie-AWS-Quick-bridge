import { describe, expect, test } from "bun:test"
import { _internal } from "../index.mjs"

const { wire, messages, toolbridge, oauth, prepare, mapModel, thinkingEffort, usageBody, settings, durationMs } = _internal

describe("wire", () => {
  test("crc32 matches the IEEE check value", () => {
    expect(wire.crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })

  test("event-stream round trip, several messages in one buffer", () => {
    const a = wire.eventStreamEncode({ ":message-type": "event", ":event-type": "x" }, "hello")
    const b = wire.eventStreamEncode({}, new Uint8Array([1, 2, 3]))
    const joined = new Uint8Array(a.length + b.length + 5)
    joined.set(a)
    joined.set(b, a.length)
    const { messages: got, consumed } = wire.eventStreamDecodeAll(joined)
    expect(consumed).toBe(a.length + b.length)
    expect(got[0].headers).toEqual({ ":message-type": "event", ":event-type": "x" })
    expect(new TextDecoder().decode(got[0].payload)).toBe("hello")
    expect([...got[1].payload]).toEqual([1, 2, 3])
  })

  test("CBOR round trip", () => {
    const value = { a: 1, b: -7, c: "héllo", d: [true, false, null, 300, 70000, 5000000000], e: { f: new Uint8Array([9, 8]) } }
    expect(wire.cborDecode(wire.cborEncode(value))).toEqual(value)
    expect(wire.cborDecode(Uint8Array.from([0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]))).toBe(1.5)
  })

  test("AIDP inbound and outbound", () => {
    const out = JSON.parse(new TextDecoder().decode(wire.aidpEncode('{"type":"ping"}')))
    expect(out.eventType).toBe("rawInputEvent")
    expect(Buffer.from(out.payload.payload, "base64").toString()).toBe('{"type":"ping"}')
    const inbound = wire.eventStreamEncode({ ":message-type": "event" }, JSON.stringify({ payload: Buffer.from('{"type":"text_delta"}').toString("base64") }))
    expect(wire.aidpDecode(inbound)).toEqual(['{"type":"text_delta"}'])
    expect(wire.aidpDecode(new TextEncoder().encode('{"type":"plain"}'))).toEqual(['{"type":"plain"}'])
    const failure = wire.eventStreamEncode({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, "{}")
    expect(() => wire.aidpDecode(failure)).toThrow("upstream error [ThrottlingException]")
  })

  test("Gateway round trip", () => {
    expect(wire.gatewayDecode(wire.gatewayEncode('{"type":"session_connect"}'))).toEqual(['{"type":"session_connect"}'])
  })
})

describe("messages", () => {
  test("a lone user prompt passes through unchanged", () => {
    expect(messages.formatPrompt([{ role: "system", content: "be brief" }, { role: "user", content: "  hi\n" }])).toBe("  hi\n")
  })

  test("a tool loop is rendered with ids and names", () => {
    const prompt = messages.formatPrompt([
      { role: "user", content: [{ type: "text", text: "weather?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }] },
      { role: "tool", tool_call_id: "c1", content: "" },
    ])
    expect(prompt).toBe(
      ['User: weather?[image]', 'Assistant tool call (id=c1, name=get_weather): {"city":"Paris"}', "Tool result (call_id=c1, name=get_weather): (empty)"].join("\n\n"),
    )
  })

  test("empty transcripts are refused", () => {
    expect(() => messages.formatPrompt([])).toThrow("messages must not be empty")
    expect(() => messages.formatPrompt([{ role: "system", content: "x" }])).toThrow("no text or tool calls")
  })

  test("system prompt keeps caller instructions first and always carries the override", () => {
    const sys = messages.systemPrompt([{ role: "system", content: "A" }, { role: "user", content: "u" }, { role: "developer", content: "B" }])
    expect(sys.startsWith("A\n\nB\n\nNote from the user:")).toBe(true)
    expect(messages.systemPrompt([{ role: "user", content: "u" }])).toBe(messages.UPSTREAM_PROMPT_OVERRIDE)
  })

  test("titles are cut at 60 characters", () => {
    expect(messages.titleFor("")).toBe("New Conversation")
    expect(messages.titleFor("好".repeat(70))).toBe("好".repeat(60) + "…")
  })
})

describe("tool bridge", () => {
  const allowed = new Set(["get_weather"])

  test("markers become tool calls, unknown tools stay text", () => {
    const { text, replies } = toolbridge.parseClientToolCalls('ok <client_tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</client_tool_call>', allowed)
    expect(text).toBe("ok")
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ name: "get_weather", arguments: '{"city":"Paris"}' })
    const unknown = '<client_tool_call>{"name":"rm","arguments":{}}</client_tool_call>'
    expect(toolbridge.parseClientToolCalls(unknown, allowed)).toEqual({ text: unknown, replies: [] })
  })

  test("bare and fenced JSON are accepted", () => {
    expect(toolbridge.parseClientToolCalls('{"name":"get_weather","arguments":{}}', allowed).replies).toHaveLength(1)
    expect(toolbridge.parseClientToolCalls('```json\n{"tool_calls":[{"name":"get_weather"}]}\n```', allowed).replies[0].arguments).toBe("{}")
  })

  test("the prompt states the tool choice", () => {
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }]
    expect(toolbridge.buildToolBridgePrompt(tools, [], "none", "", true)).toBe("")
    const prompt = toolbridge.buildToolBridgePrompt(tools, [], "function", "get_weather", false)
    expect(prompt).toContain('You must call the tool "get_weather".')
    expect(prompt).toContain("Call at most one tool per turn.")
  })

  // every way of cutting the reply into two deltas gives the same result
  function streamed(reply) {
    const results = []
    for (let cut = 0; cut <= reply.length; cut++) {
      let text = ""
      const s = new toolbridge.BridgeStream(allowed, (t) => (text += t))
      s.push(reply.slice(0, cut))
      s.push(reply.slice(cut))
      const replies = s.finish()
      results.push({ text, calls: replies.map((r) => `${r.name}${r.arguments}`) })
    }
    return results
  }

  test("text before a marker streams, the marker does not", () => {
    for (const r of streamed('Checking. <client_tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</client_tool_call>'))
      expect(r).toEqual({ text: "Checking. ", calls: ['get_weather{"city":"Paris"}'] })
  })

  test("a reply that is only a marker sends no text", () => {
    for (const r of streamed('\n<client_tool_call>{"name":"get_weather","arguments":{}}</client_tool_call>\n')) expect(r).toEqual({ text: "", calls: ["get_weather{}"] })
  })

  test("plain text, an unfinished marker and an unknown tool all arrive whole", () => {
    for (const reply of ["a < b and <client_tool nothing", '<client_tool_call>{"name":"rm"}</client_tool_call> done', '{"not":"a tool"}', "`code` first"])
      for (const r of streamed(reply)) expect(r).toEqual({ text: reply, calls: [] })
  })

  test("bare JSON is held back and becomes a call", () => {
    for (const r of streamed('{"name":"get_weather","arguments":{"city":"Rome"}}')) expect(r).toEqual({ text: "", calls: ['get_weather{"city":"Rome"}'] })
  })
})

describe("oauth", () => {
  test("discovery and redirect addresses", () => {
    expect(oauth.discoveryURL("social", "prod", "", "N", 18080, "1.2.4660")).toBe("https://quick.aws.com/sn?qwSurface=desktop%3AN%3A18080%3A1.2.4660")
    expect(oauth.discoveryURL("enterprise", "prod", "eu-west-1", "N", 18080, "1")).toStartWith("https://eu-west-1.quicksight.aws.amazon.com/sn/start/")
    expect(oauth.redirectURI("social", 18080)).toBe("http://127.0.0.1:18080")
    expect(oauth.redirectURI("enterprise", 18080)).toBe("http://localhost:18080")
  })

  test("session fields derive the WebSocket host and the expiry", () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ sub: "arn:aws:iam::1:user/a", exp: 2000000000, region: "eu-west-1" })).toString("base64url")}.y`
    const f = oauth.sessionFields(
      { quickProvider: "social", stage: "prod", tenantUrl: "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/" },
      { accessToken: "a", refreshToken: "r", idToken, expiresIn: 0 },
      { email: "ada@example.com", userName: "", displayName: "", userArn: "", awsAccountId: "", accountName: "" },
    )
    expect(f).toMatchObject({
      type: "oauth",
      accountId: "ada@example.com",
      wsHost: "cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      wsPath: "",
      actorArn: "arn:aws:iam::1:user/a",
      region: "eu-west-1",
      expires: 2000000000000,
    })
  })
})

describe("requests", () => {
  const cfg = settings({})

  test("options have their defaults", () => {
    expect(cfg).toMatchObject({ appVersion: "1.2.4660", surface: "QUICK_WORK_DESKTOP_WINDOWS", callbackPort: 18080, requestTimeoutMs: 300000, defaultModel: "smart" })
    expect(settings({ request_timeout: "90s", callback_port: 19000, thinking_effort: "HIGH", default_model: "fast" })).toMatchObject({
      requestTimeoutMs: 90000,
      callbackPort: 19000,
      thinkingEffort: "high",
      defaultModel: "fast",
    })
    expect(durationMs("1h", 0)).toBe(3600000)
    expect(durationMs(30, 0)).toBe(30000)
    expect(durationMs("soon", 7)).toBe(7)
  })

  test("models map to agent modes", () => {
    expect(mapModel("aws-quick/Fast", "smart")).toBe("fast")
    expect(mapModel("qw-balanced", "smart")).toBe("balanced")
    expect(mapModel("gpt-5", "smart")).toBe("smart")
  })

  test("reasoning effort becomes thinking_effort", () => {
    expect(thinkingEffort({ reasoning_effort: "minimal" }, "")).toBe("low")
    expect(thinkingEffort({ reasoning: { effort: "xhigh" } }, "")).toBe("high")
    expect(thinkingEffort({}, "medium")).toBe("medium")
  })

  test("a request is prepared with the bridge prompt and the forced tool", () => {
    const turn = prepare(
      {
        model: "aws-quick/auto",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }],
        tool_choice: { type: "function", function: { name: "b" } },
        parallel_tool_calls: false,
      },
      cfg,
      "",
    )
    expect(turn).toMatchObject({ model: "auto", bridge: true, stream: true, includeUsage: true, parallel: false })
    expect([...turn.bridgeAllowed]).toEqual(["b"])
    expect(turn.input.prompt).toBe("hi")
    expect(turn.input.systemPrompt).toContain("<client_tool_protocol>")
    expect(() => prepare({ n: 2, messages: [{ role: "user", content: "x" }] }, cfg, "")).toThrow("n > 1")
  })

  test("usage follows the totals Amazon Quick reports", () => {
    expect(usageBody({ prompt: 12, completion: 5, total: 20, cacheRead: 3, cacheWrite: 0 })).toEqual({
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })
})
