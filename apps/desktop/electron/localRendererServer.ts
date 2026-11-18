import http from 'http'
import fs from 'fs'
import path from 'path'
import { URL } from 'url'

export interface LocalRendererServer {
  origin: string
  port: number
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

function contentType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** Resolve a URL path to a file under root. Returns null on traversal / missing. */
export function resolveRendererPath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const resolved = path.resolve(root, relative)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep))
    return null
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
    return null
  return resolved
}

/**
 * Serve packaged renderer assets from http://127.0.0.1:<ephemeral>/ so the document
 * has a real HTTP origin. YouTube embeds require http(s) + Referer; file:// provides neither.
 * Does not spoof Referer headers — Chromium sends Referer naturally from this origin.
 */
export async function startLocalRendererServer(rendererRoot: string): Promise<LocalRendererServer> {
  const root = path.resolve(rendererRoot)
  if (!fs.existsSync(path.join(root, 'index.html')))
    throw new Error(`Renderer index.html not found under ${root}`)

  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? ''
    // Block DNS-rebinding / unexpected Host headers.
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) && host !== 'localhost' && !/^localhost:\d+$/.test(host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden host')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' })
      res.end('Method not allowed')
      return
    }
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1/').pathname
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad request')
      return
    }
    const filePath = resolveRendererPath(root, pathname)
    if (filePath == null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    const headers: Record<string, string> = {
      'Content-Type': contentType(filePath),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-cache'
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      res.end()
      return
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Read error')
        return
      }
      res.writeHead(200, headers)
      res.end(data)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (address == null || typeof address === 'string')
    throw new Error('Local renderer server did not bind a TCP port.')
  const port = address.port
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}
