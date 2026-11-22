// A local stand-in for Amazon Quick: the discovery page, the IAM Identity
// Center OIDC endpoints, user-info and the chat WebSocket (AIDP framing).
// Used by the tests, and on its own to try the plugin in a magpie sandbox:
//   bun test/mock-upstream.mjs 39100

import { createHash } from "node:crypto"
import { eventStreamEncode } from "../plugin/wire.mjs"

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`

export function startMock({ port = 0, email = "ada@example.com" } = {}) {
  const state = {
    codes: new Map(), // code -> code_challenge
    refreshes: 0,
    turns: [], // every user_message payload received
    deleted: [],
    rejectToken: "", // an id_token the WebSocket upgrade answers 401
    script: null, // (payload) => events[], overrides the default reply
  }

  const frame = (event) =>
    eventStreamEncode(
      { ":event-type": "rawOutputEvent", ":content-type": "application/json", ":message-type": "event" },
      JSON.stringify({ payload: Buffer.from(JSON.stringify(event)).toString("base64") }),
    )

  function reply(payload) {
    if (state.script) return state.script(payload)
    const usage = { type: "turn_usage", payload: { input_tokens: 12, output_tokens: 5, total_tokens: 20, cache_read_tokens: 3 } }
    const done = [usage, { type: "message_complete", payload: {} }, { type: "turn_completed", payload: {} }]
    const tool = /use the tool (\w+)/i.exec(payload.text)
    if (tool && String(payload.system_prompt ?? "").includes("<client_tool_protocol>")) {
      const marker = `<client_tool_call>{"name":"${tool[1]}","arguments":{"city":"Paris"}}</client_tool_call>`
      // split inside the marker, as a real stream may
      return [
        { type: "text_delta", payload: { delta: "Let me check. <client_to" } },
        { type: "text_delta", payload: { delta: marker.slice("<client_to".length, 40) } },
        { type: "text_delta", payload: { delta: marker.slice(40) } },
        ...done,
      ]
    }
    const words = `pong from ${payload.agent_mode}`.split(" ")
    return [...words.map((w, i) => ({ type: "text_delta", payload: { delta: (i ? " " : "") + w } })), ...done]
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url)
      const base = `http://127.0.0.1:${srv.port}`
      const json = async () => {
        try {
          return await req.json()
        } catch {
          return {}
        }
      }
      switch (url.pathname) {
        // the sign-in page: straight back to the plugin's port
        case "/sn": {
          const [, nonce, callbackPort] = (url.searchParams.get("qwSurface") ?? "").split(":")
          const to = new URL(`http://localhost:${callbackPort}/callback`)
          to.searchParams.set("nonce", nonce)
          to.searchParams.set("issuerUrl", "https://view.awsapps.com/start")
          to.searchParams.set("tenantUrl", base)
          to.searchParams.set("idcRegion", "us-east-1")
          return Response.redirect(to.toString(), 302)
        }
        case "/client/register":
          return Response.json({ clientId: "mock-client", clientSecret: "mock-secret" })
        case "/authorize": {
          const code = "code-" + Math.random().toString(36).slice(2)
          state.codes.set(code, url.searchParams.get("code_challenge"))
          const to = new URL(url.searchParams.get("redirect_uri"))
          to.searchParams.set("code", code)
          to.searchParams.set("state", url.searchParams.get("state"))
          return Response.redirect(to.toString(), 302)
        }
        case "/token": {
          const body = await json()
          const tokens = (n) => ({
            accessToken: `access-${n}`,
            refreshToken: `refresh-${n}`,
            idToken: jwt({ sub: "arn:aws:quicksight:us-east-1:123456789012:user/default/ada", n }),
            expiresIn: 3600,
          })
          if (body.grantType === "authorization_code") {
            const challenge = state.codes.get(body.code)
            const given = createHash("sha256").update(String(body.codeVerifier)).digest("base64url")
            if (!challenge || challenge !== given) return Response.json({ error: "invalid_grant" }, { status: 400 })
            state.codes.delete(body.code)
            return Response.json(tokens(0))
          }
          if (body.grantType === "refresh_token") {
            if (!String(body.refreshToken).startsWith("refresh-")) return Response.json({ error: "invalid_grant" }, { status: 400 })
            return Response.json(tokens(++state.refreshes))
          }
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 })
        }
        case "/integration/quick-work/user-info":
          if (!/^Bearer access-/.test(req.headers.get("authorization") ?? "")) return new Response("unauthorized", { status: 401 })
          return Response.json({ userInfo: { email, displayName: "Ada", awsAccountId: "123456789012", accountName: "mock" } })
        case "/streaming/quickwork-chat-bidirectional-stream": {
          const token = url.searchParams.get("token") ?? ""
          if (!token || token === state.rejectToken) return new Response("unauthorized", { status: 401 })
          if (srv.upgrade(req)) return
          return new Response("expected a WebSocket", { status: 400 })
        }
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(ws, data) {
        let event
        try {
          const outer = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"))
          event = JSON.parse(Buffer.from(outer.payload.payload, "base64").toString("utf8"))
        } catch {
          return
        }
        if (event.type === "session_delete") state.deleted.push(event.payload.session_id)
        if (event.type !== "user_message") return
        state.turns.push(event.payload)
        for (const out of reply(event.payload)) ws.send(frame(out))
      },
    },
  })

  return { server, state, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const mock = startMock({ port: Number(process.argv[2]) || 39100 })
  console.log(`mock Amazon Quick on ${mock.url}`)
  console.log(`plugin options: ${JSON.stringify({ oidc_base: mock.url, discovery_url: mock.url + "/sn", data_plane_url: mock.url })}`)
}
