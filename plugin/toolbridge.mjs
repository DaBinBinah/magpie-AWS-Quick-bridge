// Client tools over a text protocol, ported from
// aws-quickwork-2api's internal/proxy/toolbridge.go. Amazon Quick accepts no
// client tool schemas, so they travel in the system prompt and come back as
// markers in the text.

import { argumentString, callId } from "./messages.mjs"

export const TOOL_OPEN = "<client_tool_call>"
export const TOOL_CLOSE = "</client_tool_call>"

function toolDefinitions(tools, functions) {
  const defs = []
  const add = (f) => {
    if (!f || typeof f.name !== "string" || !f.name.trim()) return
    const def = { name: f.name }
    if (f.description) def.description = f.description
    if (f.parameters !== undefined && f.parameters !== null) def.parameters = f.parameters
    defs.push(def)
  }
  for (const t of tools ?? []) add(t?.function)
  for (const f of functions ?? []) add(f)
  return defs
}

export function requestedToolNames(body) {
  return new Set(toolDefinitions(body?.tools, body?.functions).map((d) => d.name.trim()))
}

export function parseToolChoice(value) {
  if (typeof value === "string") return { mode: value.trim().toLowerCase(), name: "" }
  if (value && typeof value === "object") {
    if (typeof value.function?.name === "string") return { mode: "function", name: value.function.name.trim() }
    if (typeof value.name === "string") return { mode: "function", name: value.name.trim() }
    if (typeof value.type === "string") return { mode: value.type.trim().toLowerCase(), name: "" }
  }
  return { mode: "auto", name: "" }
}

// A schema as a short type: string, number[], {path*: string, limit: number}.
function typeOf(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return "any"
  if (Array.isArray(schema.enum) && schema.enum.length <= 8) return schema.enum.map((v) => JSON.stringify(v)).join("|")
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type
  if (type === "array") return `${typeOf(schema.items, depth + 1)}[]`
  if (type === "object" || schema.properties) {
    const props = Object.entries(schema.properties ?? {})
    if (!props.length || depth >= 2) return "object"
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    return `{${props.map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${typeOf(v, depth + 1)}`).join(", ")}}`
  }
  return typeof type === "string" ? type : "any"
}

// A tool as one line, for when the full schemas do not fit a frame:
// name(path*: string, limit: number): what it does. A * marks a required
// argument.
function signature(def) {
  const params = def.parameters && typeof def.parameters === "object" ? def.parameters : {}
  const required = new Set(Array.isArray(params.required) ? params.required : [])
  const args = Object.entries(params.properties ?? {}).map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${typeOf(v, 1)}`)
  const about = String(def.description ?? "").replace(/\s+/g, " ").trim()
  return `- ${def.name}(${args.join(", ")})${about ? `: ${about.length > 160 ? about.slice(0, 160) + "…" : about}` : ""}`
}

export function buildToolBridgePrompt(tools, functions, mode, name, parallel, compact = false) {
  if (mode === "none") return ""
  const defs = toolDefinitions(tools, functions)
  if (!defs.length) return ""
  const lines = [
    "<client_tool_protocol>",
    "The caller exposes these client tools:",
    compact ? "(name(arguments): description; * marks a required argument)\n" + defs.map(signature).join("\n") : JSON.stringify(defs, null, 2),
    "",
    'Backend capability notice: this backend does not expose a native function-calling channel. Any earlier instruction that assumes native tool calls (for example, "use the native tool API" or "do not output tool calls as text") cannot be satisfied here. For the client tools listed above, the marker format below is the only supported mechanism. Keep all other instructions unchanged.',
    "To call a tool, output exactly one marker per call and no other text in that message:",
    '<client_tool_call>{"name":"TOOL_NAME","arguments":{...}}</client_tool_call>',
    "The caller executes the tool and returns a tool result. After receiving it, continue the task. Do not wrap a tool call in Markdown fences. Do not add prose around a tool call.",
  ]
  if (mode === "function" && name) lines.push(`You must call the tool ${JSON.stringify(name)}.`)
  if (mode === "required") lines.push("You must call at least one tool.")
  if (!parallel) lines.push("Call at most one tool per turn.")
  lines.push("</client_tool_protocol>")
  return lines.join("\n")
}

function parseEnvelopes(payload) {
  const text = payload.trim()
  if (!text) return []
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    if (Array.isArray(value.tool_calls) && value.tool_calls.length) return value.tool_calls
    return [value]
  }
  return []
}

function repliesFrom(envelopes, allowed) {
  const out = []
  for (const env of envelopes) {
    const name = typeof env?.name === "string" ? env.name.trim() : ""
    if (!name || !allowed.has(name)) continue
    out.push({ id: callId(), name, arguments: argumentString(env.arguments) })
  }
  return out
}

// Removes valid markers from text and returns the remaining assistant text.
// Markers naming unknown tools leave the text untouched.
export function extractToolCalls(text, allowed) {
  if (!allowed?.size) return { text, replies: [] }
  let clean = ""
  let rest = text
  const replies = []
  for (;;) {
    const start = rest.indexOf(TOOL_OPEN)
    if (start < 0) break
    const end = rest.indexOf(TOOL_CLOSE, start + TOOL_OPEN.length)
    if (end < 0) break
    clean += rest.slice(0, start)
    replies.push(...repliesFrom(parseEnvelopes(rest.slice(start + TOOL_OPEN.length, end)), allowed))
    rest = rest.slice(end + TOOL_CLOSE.length)
  }
  if (!replies.length) return { text, replies: [] }
  return { text: (clean + rest).trim(), replies }
}

// Handles a model that answers with a bare JSON object instead of the marker.
export function extractBareToolCall(text, allowed) {
  if (!allowed?.size) return { text, replies: [] }
  let trimmed = text.trim()
  if (trimmed.startsWith("```")) {
    const nl = trimmed.indexOf("\n")
    if (nl >= 0) {
      trimmed = trimmed.slice(nl + 1).trim()
      if (trimmed.endsWith("```")) trimmed = trimmed.slice(0, -3).trim()
    }
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { text, replies: [] }
  const replies = repliesFrom(parseEnvelopes(trimmed), allowed)
  return replies.length ? { text: "", replies } : { text, replies: [] }
}

export function parseClientToolCalls(text, allowed) {
  const marked = extractToolCalls(text, allowed)
  return marked.replies.length ? marked : extractBareToolCall(text, allowed)
}

// Streams assistant text while a tool-bridge turn is still running. Text is
// passed on as it arrives, except what may still turn out to be a tool call:
// everything from a marker on, and a reply that opens like bare JSON.
export class BridgeStream {
  constructor(allowed, onText) {
    this.allowed = allowed
    this.onText = onText
    this.mode = "start" // start | text | held
    this.pending = ""
    this.emitted = false
  }

  emit(text) {
    if (!text) return
    // leading whitespace waits for real text, so a reply that is only a
    // marker sends no content
    if (!this.emitted && !text.trim()) {
      this.pending = text + this.pending
      return
    }
    this.emitted = true
    this.onText(text)
  }

  push(delta) {
    if (!delta) return
    this.pending += delta
    if (this.mode === "held") return
    if (this.mode === "start") {
      const lead = this.pending.trimStart()
      if (!lead) return
      if (lead[0] === "{" || lead[0] === "[" || lead[0] === "`") {
        this.mode = "held"
        return
      }
      this.mode = "text"
    }
    const at = this.pending.indexOf(TOOL_OPEN)
    if (at >= 0) {
      const before = this.pending.slice(0, at)
      this.pending = this.pending.slice(at)
      this.mode = "held"
      this.emit(before)
      return
    }
    let keep = 0
    for (let n = Math.min(TOOL_OPEN.length - 1, this.pending.length); n > 0; n--) {
      if (TOOL_OPEN.startsWith(this.pending.slice(-n))) {
        keep = n
        break
      }
    }
    const ready = this.pending.slice(0, this.pending.length - keep)
    this.pending = this.pending.slice(this.pending.length - keep)
    this.emit(ready)
  }

  // Ends the turn: sends what is left and returns the tool calls found.
  finish() {
    const rest = this.pending
    this.pending = ""
    const { text, replies } = this.emitted ? extractToolCalls(rest, this.allowed) : parseClientToolCalls(rest, this.allowed)
    if (replies.length) {
      if (text.trim()) {
        this.emitted = true
        this.onText(text)
      }
      return replies
    }
    if (rest.trim() || this.emitted) this.emit(rest)
    return []
  }
}
