// Serves the built app and forwards /rest/v1/* to PostgREST (what Supabase's gateway does). Local test use only.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' }
export function startServer({ dist, port, upstream }) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/rest/v1/')) {
      const target = new URL(req.url.replace('/rest/v1', ''), upstream)
      const proxied = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
      proxied.on('error', () => { res.writeHead(502); res.end('{"message":"upstream down"}') })
      req.pipe(proxied)
      return
    }
    if (req.url.startsWith('/auth/v1/')) { res.writeHead(204); res.end(); return }
    let file = path.join(dist, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html')
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}
