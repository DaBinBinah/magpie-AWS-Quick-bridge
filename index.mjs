// magpie-AWS-Quick-bridge: Amazon Quick (QuickWork) as a provider for magpie
// and OpenCode. It signs in with Amazon Quick's own desktop OAuth flow and
// answers chat completions over Amazon Quick's chat WebSocket.

import { MODES, chatCompletions, compose, errorResponse, failureResponse, mapModel, prepare, thinkingEffort, usageBody } from "./plugin/chat.mjs"
import { browserSignIn } from "./plugin/login.mjs"
import * as messages from "./plugin/messages.mjs"
import * as oauth from "./plugin/oauth.mjs"
import * as qbs from "./plugin/qbs.mjs"
import { accountModels, durationMs, models, settings } from "./plugin/settings.mjs"
import * as threads from "./plugin/threads.mjs"
import * as toolbridge from "./plugin/toolbridge.mjs"
import * as upstream from "./plugin/upstream.mjs"
import * as wire from "./plugin/wire.mjs"

const ID = "aws-quick"
// Requests never leave for this address: the loader's fetch answers them.
const BASE = "https://aws-quick.invalid/v1"
const KEEP_SESSIONS = "keep_sessions"
const REFRESH_LEAD_MS = 10 * 60_000
// magpie's id for the conversation a request belongs to (chat.headers)
const CONVERSATION = "x-aws-quick-conversation"

const ACCOUNT_TYPE = {
  type: "select",
  key: "provider",
  message: "Account type",
  messages: { zh: "账号类型", "zh-TW": "帳號類型" },
  options: [
    {
      label: "Personal (Builder ID, Google, Amazon…)",
      value: "social",
      hint: "quick.aws.com sign-in",
      labels: { zh: "个人账号（Builder ID、Google、Amazon 等）", "zh-TW": "個人帳號（Builder ID、Google、Amazon 等）" },
      hints: { zh: "quick.aws.com 登录", "zh-TW": "quick.aws.com 登入" },
    },
    {
      label: "Enterprise (IAM Identity Center / SSO)",
      value: "enterprise",
      hint: "Your organization's Amazon Quick",
      labels: { zh: "企业账号（IAM Identity Center / SSO）", "zh-TW": "企業帳號（IAM Identity Center / SSO）" },
      hints: { zh: "所在组织的 Amazon Quick", "zh-TW": "所屬組織的 Amazon Quick" },
    },
    { label: "Personal via Gateway (experimental)", value: "social_gateway", labels: { zh: "个人账号 · Gateway（实验性）" } },
    { label: "Enterprise via Gateway (experimental)", value: "gateway", labels: { zh: "企业账号 · Gateway（实验性）" } },
  ],
}

const REGION = {
  type: "text",
  key: "region",
  message: "AWS region of your organization's Amazon Quick (blank uses us-east-1)",
  messages: { zh: "组织 Amazon Quick 所在的 AWS 区域（留空为 us-east-1）", "zh-TW": "組織 Amazon Quick 所在的 AWS 區域（留空為 us-east-1）" },
  placeholder: "us-east-1",
  condition: (inputs) => inputs.provider === "enterprise" || inputs.provider === "gateway",
  validate: (value) => (!value || /^[a-z]{2}(-[a-z]+)+-\d$/.test(String(value).trim()) ? undefined : "Enter a valid AWS region"),
}

const server = async (input, options) => {
  const base = settings(options)
  oauth.setEndpoints({ oidcBase: options?.oidc_base, discoveryUrl: options?.discovery_url, dataPlaneUrl: options?.data_plane_url })
  // magpie's switch (the provider's editor) goes over the option of the same name
  const cfg = () => ({ ...base, keepSessions: base.keepSessions || input?.magpie?.option?.(ID, KEEP_SESSIONS) === true })

  // Renews are shared per refresh token, for hosts without auth.refresh
  // (OpenCode, older magpie) where two requests may find the token old.
  const renewing = new Map()
  async function renewed(auth) {
    if (auth.type !== "oauth" || !auth.expires || auth.expires - Date.now() > 60_000) return auth
    let pending = renewing.get(auth.refresh)
    if (!pending) {
      pending = (async () => {
        const next = { ...auth, ...(await oauth.refresh(auth)) }
        await input?.client?.auth?.set?.({ path: { id: ID }, body: next })
        return next
      })().finally(() => renewing.delete(auth.refresh))
      renewing.set(auth.refresh, pending)
    }
    return pending
  }

  return {
    "chat.headers": async (hook, output) => {
      if ((hook?.model?.providerID ?? hook?.provider?.info?.id) === ID && hook?.sessionID) output.headers[CONVERSATION] = String(hook.sessionID).slice(0, 128)
    },
    provider: {
      id: ID,
      // magpie asks for each account; a failure leaves the list as it was
      async models(provider, { auth } = {}) {
        const listed = provider?.models ?? {}
        if (auth?.type !== "oauth" || !auth.access) return listed
        try {
          return accountModels(listed, await qbs.settings(auth))
        } catch {
          return listed
        }
      },
    },
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Amazon Quick",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        ...was,
        models: { ...models(), ...(was.models ?? {}) },
      }
    },
    auth: {
      provider: ID,
      refreshLead: REFRESH_LEAD_MS,
      options: [
        {
          key: KEEP_SESSIONS,
          label: "Show conversations in Amazon Quick",
          description: "Conversations are incognito by default: they stay out of Amazon Quick's chat list and its memory. Turn this on to have them listed there, where Amazon Quick may also save things from them to its memory.",
          labels: { zh: "在 Amazon Quick 里显示对话", "zh-TW": "在 Amazon Quick 裡顯示對話" },
          descriptions: {
            zh: "对话默认是隐身的：不出现在 Amazon Quick 的聊天列表里，也不写入它的记忆。打开后对话会列在那里，Amazon Quick 也可能把其中的内容存进它的记忆。",
            "zh-TW": "對話預設是隱身的：不出現在 Amazon Quick 的聊天列表裡，也不寫入它的記憶。開啟後對話會列在那裡，Amazon Quick 也可能把其中的內容存進它的記憶。",
          },
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "Amazon Quick (browser sign-in)",
          labels: { zh: "Amazon Quick（浏览器登录）", "zh-TW": "Amazon Quick（瀏覽器登入）" },
          prompts: [ACCOUNT_TYPE, REGION],
          authorize: (inputs, ctx) => browserSignIn(inputs, cfg(), ctx),
        },
      ],
      // magpie's hook: how much of the plan is used. A refusal here never
      // marks the account: only a chat request does.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !auth.access) return { error: "not signed in", windows: [], signIn: "kept" }
        try {
          return { ...(await qbs.usage(auth)), signIn: "kept" }
        } catch (e) {
          return { error: String(e?.message ?? e), windows: [], signIn: "kept" }
        }
      },
      // magpie's hook: renews the account's tokens before they expire
      async refresh(auth) {
        if (auth?.type !== "oauth") return
        return oauth.refresh(auth)
      },
      async loader(getAuth) {
        return {
          baseURL: BASE,
          apiKey: "aws-quick",
          async fetch(request, init) {
            const url = new URL(request instanceof Request ? request.url : String(request))
            const method = (init?.method ?? (request instanceof Request ? request.method : "GET")).toUpperCase()
            const path = url.pathname.replace(/\/+$/, "")
            if (path.endsWith("/models") && method === "GET") {
              const created = Math.floor(Date.now() / 1000)
              return Response.json({ object: "list", data: MODES.map((id) => ({ id, object: "model", created, owned_by: "amazon-quick" })) })
            }
            if (!path.endsWith("/chat/completions") || method !== "POST")
              return errorResponse(404, "not_found", `Amazon Quick serves chat completions only, not ${method} ${url.pathname}`)

            let body
            try {
              const raw = init?.body ?? (request instanceof Request ? await request.text() : "")
              body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
            } catch {
              return errorResponse(400, "invalid_request_error", "the request body is not JSON")
            }

            let auth = await getAuth()
            if (auth?.type !== "oauth") return errorResponse(401, "upstream_session_unavailable", "Amazon Quick is not signed in")
            try {
              auth = await renewed(auth)
            } catch (e) {
              if (e?.signIn === "expired") return errorResponse(401, "upstream_session_unavailable", e.message, { "x-magpie-sign-in": "expired" })
              // the old token is sent on; Amazon Quick's answer says the rest
            }
            const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined))
            return chatCompletions({
              body,
              auth,
              cfg: cfg(),
              signal: init?.signal ?? (request instanceof Request ? request.signal : undefined),
              conversation: headers.get(CONVERSATION) ?? headers.get("x-thread-id") ?? "",
            })
          },
        }
      },
    },
  }
}

export default { id: "magpie-aws-quick-bridge", server }

// for tests
export const _internal = { settings, durationMs, models, prepare, compose, mapModel, thinkingEffort, usageBody, failureResponse, chatCompletions, accountModels, threads, messages, oauth, qbs, toolbridge, upstream, wire }
