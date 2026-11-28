// Files a conversation carries (images, PDFs and a few kinds of text), and
// the download of those it only gives the address of, so that they can go
// to Amazon Quick as attachments.

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export const FILE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
}
const EXT_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv" }
const ALIAS = { "image/jpg": "image/jpeg" }

export const mimeOf = (type) => {
  const m = String(type ?? "").split(";")[0].trim().toLowerCase()
  return ALIAS[m] ?? m
}
export const isImage = (type) => FILE_EXT[type] !== undefined && type.startsWith("image/")
const imageOrPdf = (type) => isImage(type) || type === "application/pdf"

// A data URL, or bare base64 named by its file name, as { mimeType, base64 }
// when it is a kind that can be attached.
export function dataFile(data, filename = "") {
  if (typeof data !== "string" || !data) return null
  const url = /^data:([^;,]+)(?:;[^,;]*)*;base64,(.+)$/is.exec(data)
  const mimeType = url ? mimeOf(url[1]) : EXT_TYPE[String(filename).split(".").pop().toLowerCase()]
  const base64 = url ? url[2] : /^[A-Za-z0-9+/=\s]+$/.test(data) ? data : ""
  return mimeType && FILE_EXT[mimeType] && base64 ? { mimeType, base64 } : null
}

// A file name that is safe to give: no folders, no control characters, and
// ending with the extension of its kind.
export function fileName(wanted, mimeType, fallback) {
  const ext = FILE_EXT[mimeType]
  let name = String(wanted ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .trim()
    .slice(0, 100)
  if (!name || name.startsWith(".")) name = fallback
  return name.toLowerCase().endsWith(`.${ext}`) || (ext === "jpg" && /\.jpe?g$/i.test(name)) ? name : `${name}.${ext}`
}

// What the bytes are, for files served without a useful type.
export function sniff(b) {
  const at = (i, s) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0))
  if (b[0] === 0x89 && at(1, "PNG")) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (at(0, "GIF8")) return "image/gif"
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp"
  if (at(0, "%PDF-")) return "application/pdf"
  return ""
}

// 198.18.0.0/15 is not counted: proxies in fake-IP mode (Clash, Surge)
// answer every name with an address there and carry the connection out.
function privateV4(ip) {
  const [a, b] = ip.split(".").map(Number)
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0))
  )
}

// Whether an address is this machine, its network, or not a plain public
// one; anything that is not an IP address counts as private.
export function privateAddress(raw) {
  const ip = String(raw ?? "").replace(/^\[|\]$/g, "").toLowerCase()
  if (isIP(ip) === 4) return privateV4(ip)
  if (isIP(ip) !== 6) return true
  const dotted = /^[0:]*:(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (dotted) return privateV4(dotted[1])
  const hex = /^[0:]*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const first = ip.startsWith(":") ? 0 : parseInt(ip.split(":")[0], 16)
  // ::/16 (loopback, unspecified, v4-compatible), unique-local, link-local,
  // multicast, and the prefixes that carry an IPv4 address (NAT64, 6to4)
  return first === 0 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || first === 0x64 || first === 0x2002
}

export const REMOTE_MAX_BYTES = 10 * 1024 * 1024
const REMOTE_TIMEOUT_MS = 20_000
const resolveHost = (host) => lookup(host, { all: true, verbatim: true })

// Downloads a file a conversation gives the address of: http(s) only, at
// most 10 MB, never from this machine or its network (each redirect is
// checked again), and only of a kind `accept` takes.
export async function download(address, { signal, accept = imageOrPdf, fetch: get = fetch, resolve = resolveHost } = {}) {
  let url = new URL(address)
  const timeout = AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http and https addresses are downloaded")
    const host = url.hostname.replace(/^\[|\]$/g, "")
    const addresses = /^localhost$|\.localhost$/i.test(host) ? [] : isIP(host) ? [{ address: host }] : await resolve(host)
    if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new Error(`${host} is this machine or on its network`)
    const res = await get(url, { redirect: "manual", signal: stop })
    const next = res.status >= 300 && res.status < 400 && res.headers.get("location")
    if (next) {
      await res.body?.cancel().catch(() => {})
      url = new URL(next, url)
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    if (Number(res.headers.get("content-length")) > REMOTE_MAX_BYTES) {
      await res.body?.cancel().catch(() => {})
      throw new Error("larger than 10 MB")
    }
    const chunks = []
    let size = 0
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength
      if (size > REMOTE_MAX_BYTES) throw new Error("larger than 10 MB")
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const c of chunks) {
      bytes.set(c, at)
      at += c.byteLength
    }
    const said = mimeOf(res.headers.get("content-type"))
    const mimeType = sniff(bytes) || (FILE_EXT[said] ? said : "")
    if (!mimeType || !accept(mimeType)) throw new Error(`not a file that can be attached (${said || "no type"})`)
    return { mimeType, bytes }
  }
  throw new Error("too many redirects")
}

function remote(part) {
  const web = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "")
  if (part?.type === "image_url") return web(typeof part.image_url === "string" ? part.image_url : part.image_url?.url)
  if (part?.type === "file" && !part.file?.file_data) return web(part.file?.file_url)
  return ""
}

// The messages with the files they give by address (the newest `max` of
// them) put in as data, where they could be downloaded; the rest stay as
// they were.
export async function fetchRemote(messages, { signal, download: get = download, max = 10 } = {}) {
  const found = []
  messages.forEach((m, i) => {
    const role = String(m?.role ?? "").toLowerCase()
    if ((role !== "user" && role !== "tool") || !Array.isArray(m.content)) return
    m.content.forEach((part, j) => {
      const url = remote(part)
      if (url) found.push({ i, j, url, image: part.type === "image_url" })
    })
  })
  if (!found.length) return messages
  const got = await Promise.all(
    found.slice(-max).map(async (f) => {
      try {
        return { ...f, file: await get(f.url, { signal, accept: f.image ? isImage : imageOrPdf }) }
      } catch (e) {
        if (signal?.aborted) throw e
        return null
      }
    }),
  )
  const out = messages.map((m) => (Array.isArray(m?.content) ? { ...m, content: [...m.content] } : m))
  for (const g of got) {
    if (!g) continue
    const data = `data:${g.file.mimeType};base64,${Buffer.from(g.file.bytes).toString("base64")}`
    const part = out[g.i].content[g.j]
    let name = part.file?.filename || new URL(g.url).pathname.split("/").pop() || ""
    try {
      name = decodeURIComponent(name)
    } catch {}
    out[g.i].content[g.j] = g.image ? { type: "image_url", image_url: { url: data } } : { type: "file", file: { filename: name, file_data: data } }
  }
  return out
}
