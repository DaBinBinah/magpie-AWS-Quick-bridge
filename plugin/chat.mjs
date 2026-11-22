// OpenAI chat completions on top of one Amazon Quick turn, ported from
// aws-quickwork-2api's internal/proxy/server.go. Account rotation and retries
// are magpie's, so a request is tried once and a failure is answered with a
// status magpie can act on.

import { callId, formatPrompt, lastUserText, systemPrompt, titleFor, uuid } from "./messages.mjs"
import { BridgeStream, buildToolBridgePrompt, parseClientToolCalls, parseToolChoice, requestedToolNames } from "./toolbridge.mjs"
import { UpstreamError, chat, sessionFromAuth } from "./upstream.mjs"

export const MODES = ["smart", "fast", "balanced", "auto"]

export function mapModel(model, fallback) {
  let m = String(model ?? "").trim().toLowerCase()
  m = m.slice(m.lastIndexOf("/") + 1)
  if (m.startsWith("qw-")) m = m.slice(3)
  return MODES.includes(m) ? m : fallback
}

// The reasoning effort a request asked for, as Amazon Quick's
// thinking_effort; the option's value when it asked for none.
export function thinkingEffort(body, fallback) {
  const asked = String(body?.reasoning_effort ?? body?.reasoning?.effort ?? "").trim().toLowerCase()
  if (!asked) return fallback
  if (asked === "none" || asked === "off") return "off"
  if (asked === "minimal" || asked === "low") return "low"
  if (asked === "medium") return "medium"
  return "high"
}

export function usageBody(u) {
  const completion = u.completion
  const total = u.total || u.prompt + u.cacheRead + u.cacheWrite + completion
  let prompt = total - completion
  if (prompt < 0) prompt = u.prompt + u.cacheRead + u.cacheWrite
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
  if (u.cacheRead > 0) out.prompt_tokens_details = { cached_tokens: u.cacheRead }
  return out
}

export function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

const THROTTLED = /thrott|rate.?limit|too many requests|quota|limit exceeded|capacity/i

// The answer for a turn that failed before anything was sent.
export function failureResponse(error) {
  if (!(error instanceof UpstreamError)) return errorResponse(502, "upstream_error", String(error?.message ?? error))
  if (error.kind === "handshake" && error.status === 401)
    return errorResponse(401, "upstream_session_unavailable", `Amazon Quick refused the sign-in; sign in again (${error.message})`, {
      "x-magpie-sign-in": "expired",
    })
  if (error.kind === "handshake" && error.status === 403) return errorResponse(403, "upstream_forbidden", error.message)
  if (error.kind === "handshake" && error.status === 429) return errorResponse(429, "rate_limit_exceeded", error.message)
  if (error.kind === "timeout") return errorResponse(504, "upstream_timeout", error.message)
  if (error.kind === "upstream" && THROTTLED.test(error.message)) return errorResponse(429, "rate_limit_exceeded", error.message)
  return errorResponse(502, "upstream_error", error.message)
}

function nativeToolCalls(calls, turn) {
  if (turn.choice.mode === "none" || !turn.allowed.size) return []
  const out = []
  for (const tc of calls) {
    if (!turn.allowed.has(tc.name)) continue
    if (turn.choice.mode === "function" && turn.choice.name && tc.name !== turn.choice.name) continue
    if (!turn.parallel && out.length) break
    out.push({ id: tc.id || callId(), name: tc.name, arguments: tc.arguments.trim() || "{}" })
  }
  return out
}

const wireToolCall = (r, index) => ({
  ...(index === undefined ? {} : { index }),
  id: r.id,
  type: "function",
  function: { name: r.name, arguments: r.arguments },
})

// Reads a chat completions body into what one upstream turn needs.
export function prepare(body, cfg, threadId) {
  if (!body || typeof body !== "object") throw new Error("the request body is not a JSON object")
  if (Number(body.n) > 1) throw new Error("n > 1 is not supported")
  const prompt = formatPrompt(body.messages)
  const allowed = requestedToolNames(body)
  const choice = parseToolChoice(body.tool_choice ?? body.function_call)
  if (choice.mode === "function" && choice.name) allowed.add(choice.name)
  const parallel = body.parallel_tool_calls !== false
  const bridgePrompt = buildToolBridgePrompt(body.tools, body.functions, choice.mode, choice.name, parallel)
  let system = systemPrompt(body.messages)
  if (bridgePrompt) system += "\n\n" + bridgePrompt
  const model = mapModel(body.model, cfg.defaultModel)
  return {
    model,
    allowed,
    choice,
    parallel,
    bridge: bridgePrompt !== "",
    bridgeAllowed: choice.mode === "function" && choice.name ? new Set([choice.name]) : allowed,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    input: {
      prompt,
      model,
      threadId,
      title: titleFor(lastUserText(body.messages)),
      systemPrompt: system,
      thinkingEffort: thinkingEffort(body, cfg.thinkingEffort),
    },
  }
}

async function complete(turn, run) {
  const res = await run(null)
  let text = res.text
  let replies = []
  if (turn.bridge) {
    ;({ text, replies } = parseClientToolCalls(text, turn.bridgeAllowed))
    if (!turn.parallel) replies = replies.slice(0, 1)
  }
  const calls = replies.length ? replies : nativeToolCalls(res.toolCalls, turn)
  if (!text.trim() && !calls.length) return errorResponse(502, "upstream_error", "upstream returned no text or tool calls")
  const message = { role: "assistant", content: text.trim() ? text : null }
  if (calls.length) message.tool_calls = calls.map((c) => wireToolCall(c))
  return Response.json({
    id: turn.id,
    object: "chat.completion",
    created: turn.created,
    model: turn.model,
    choices: [{ index: 0, message, finish_reason: replies.length || (!text.trim() && calls.length) ? "tool_calls" : "stop" }],
    usage: usageBody(res.usage),
  })
}

// Streams a turn as SSE. The Response is returned once the first chunk is
// ready, so a turn that fails before that is still answered with a status
// (and magpie can move on to another account).
function stream(turn, run, abort) {
  const encoder = new TextEncoder()
  let controller
  let started = false
  let closed = false
  let first
  const ready = new Promise((resolve, reject) => (first = { resolve, reject }))
  const body = new ReadableStream({
    start(c) {
      controller = c
    },
    cancel() {
      closed = true
      abort.abort()
    },
  })
  const raw = (payload) => {
    if (closed) return
    controller.enqueue(encoder.encode(typeof payload === "string" ? payload : `data: ${JSON.stringify(payload)}\n\n`))
  }
  const chunk = (delta, finish = null, extra = {}) => {
    const base = { id: turn.id, object: "chat.completion.chunk", created: turn.created, model: turn.model }
    if (!started) {
      started = true
      raw({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
      first.resolve()
    }
    raw({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
  }
  const end = () => {
    raw("data: [DONE]\n\n")
    if (!closed) controller.close()
    closed = true
  }

  let sawText = false
  const text = (t) => {
    sawText = true
    chunk({ content: t })
  }
  const bridge = turn.bridge ? new BridgeStream(turn.bridgeAllowed, text) : null

  run((event) => {
    if (event.type !== "text" || !event.text) return
    if (bridge) bridge.push(event.text)
    else text(event.text)
  })
    .then((res) => {
      let replies = bridge ? bridge.finish() : []
      if (!turn.parallel) replies = replies.slice(0, 1)
      const calls = replies.length ? replies : nativeToolCalls(res.toolCalls, turn)
      if (!sawText && !calls.length) throw new UpstreamError("upstream", "upstream returned no text or tool calls")
      calls.forEach((c, i) => chunk({ tool_calls: [wireToolCall(c, i)] }))
      chunk({}, replies.length || (!sawText && calls.length) ? "tool_calls" : "stop")
      if (turn.includeUsage) {
        raw({ id: turn.id, object: "chat.completion.chunk", created: turn.created, model: turn.model, choices: [], usage: usageBody(res.usage) })
      }
      end()
    })
    .catch((error) => {
      if (!started) return first.reject(error)
      raw({ error: { message: String(error?.message ?? error), type: "upstream_error", code: "upstream_error" } })
      end()
    })

  return ready.then(
    () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
      }),
  )
}

// Answers one POST /chat/completions for the account `auth`.
export async function chatCompletions({ body, auth, cfg, signal, threadId }) {
  let turn
  try {
    turn = prepare(body, cfg, threadId)
  } catch (e) {
    return errorResponse(400, "invalid_request_error", e.message)
  }
  turn.id = "chatcmpl-" + uuid().replaceAll("-", "")
  turn.created = Math.floor(Date.now() / 1000)

  const abort = new AbortController()
  const onAbort = () => abort.abort(signal.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  const run = async (onEvent) => {
    try {
      return await chat({ session: sessionFromAuth(auth, cfg), cfg, input: turn.input, signal: abort.signal, onEvent })
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  try {
    return await (turn.stream ? stream(turn, run, abort) : complete(turn, run))
  } catch (e) {
    if (signal?.aborted) throw e
    return failureResponse(e)
  }
}
