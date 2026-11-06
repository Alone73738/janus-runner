// JANUS Cloud 3.3.0 — tiny MCP client (Model Context Protocol, "Streamable HTTP" transport: JSON-RPC over POST,
// answers as JSON or as an SSE stream). Used by the Worker (connect test: list tools) and by the runner (call tools).
// (The old two-endpoint SSE transport, GET /sse + POST /messages, is NOT supported.)
const PROTO = '2025-06-18';
const clip = (s, n) => (s = String(s ?? ''), s.length > n ? s.slice(0, n) + '…' : s);

function parseSSE(text) { const out = []; for (const block of String(text).split(/\r?\n\r?\n/)) { const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); if (!data) continue; try { out.push(JSON.parse(data)); } catch { } } return out; }

export class MCP {
  constructor(url, headers = {}, fetchImpl = fetch) { this.url = url; this.h = headers || {}; this.f = fetchImpl; this.sid = null; this.n = 0; this.ready = false; }
  async rpc(method, params, notify) {
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++this.n }) };
    const r = await this.f(this.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.sid ? { 'mcp-session-id': this.sid } : {}), 'mcp-protocol-version': PROTO, ...this.h }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'tools/call' ? 120000 : 15000) });
    const sid = r.headers.get('mcp-session-id'); if (sid) this.sid = sid;
    if (notify) return null;
    if (!r.ok) throw new Error('MCP ' + method + ' HTTP ' + r.status + ' ' + clip(await r.text().catch(() => ''), 160));
    const ct = r.headers.get('content-type') || ''; const t = await r.text();
    const msgs = /event-stream/.test(ct) ? parseSSE(t) : [JSON.parse(t)];
    const m = msgs.find(x => x && x.id === body.id) || msgs[msgs.length - 1];
    if (!m) throw new Error('MCP ' + method + ': empty answer');
    if (m.error) throw new Error('MCP ' + method + ': ' + clip(m.error.message || JSON.stringify(m.error), 200));
    return m.result;
  }
  async init() { if (this.ready) return; const r = await this.rpc('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'JANUS', version: '5.3.0' } }); this.info = r && r.serverInfo; try { await this.rpc('notifications/initialized', null, true); } catch { } this.ready = true; }
  async tools() { await this.init(); const out = []; let cursor; for (let i = 0; i < 10; i++) { const r = await this.rpc('tools/list', cursor ? { cursor } : {}); out.push(...(r.tools || [])); cursor = r.nextCursor; if (!cursor) break; } return out; }
  async call(name, args) { await this.init(); const r = await this.rpc('tools/call', { name, arguments: args || {} }); return r; }
}

/** MCP tool result → short text for the model */
export function mcpText(r) {
  if (!r) return '(no result)';
  const parts = (r.content || []).map(c => c.type === 'text' ? c.text : c.type === 'image' ? '[image ' + (c.mimeType || '') + ']' : c.type === 'resource' ? (c.resource && (c.resource.text || c.resource.uri)) || '[resource]' : JSON.stringify(c));
  if (r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent));
  return (r.isError ? 'TOOL ERROR: ' : '') + clip(parts.join('\n'), 12000);
}

/** JSON-schema → the plain subset every provider accepts (Gemini rejects $schema, additionalProperties, anyOf…) */
export function cleanSchema(s, depth = 0) {
  if (!s || typeof s !== 'object' || depth > 6) return { type: 'string' };
  let t = Array.isArray(s.type) ? s.type.find(x => x !== 'null') : s.type;
  if (!t && (s.anyOf || s.oneOf)) { const f = (s.anyOf || s.oneOf).find(x => x && x.type && x.type !== 'null'); if (f) return cleanSchema({ ...f, description: s.description || f.description }, depth); }
  if (!t) t = s.properties ? 'object' : 'string';
  const o = { type: t }; if (s.description) o.description = clip(s.description, 400);
  if (Array.isArray(s.enum) && s.enum.every(x => typeof x === 'string')) o.enum = s.enum.slice(0, 50);
  if (t === 'object') { o.properties = {}; for (const [k, v] of Object.entries(s.properties || {}).slice(0, 40)) o.properties[k.replace(/[^\w-]/g, '_').slice(0, 60)] = cleanSchema(v, depth + 1); const req = (s.required || []).filter(k => o.properties[k]); if (req.length) o.required = req; }
  if (t === 'array') o.items = cleanSchema(s.items || { type: 'string' }, depth + 1);
  return o;
}
export const toolName = (srv, t) => ('mcp_' + String(srv).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 16) + '_' + String(t).replace(/[^A-Za-z0-9_]+/g, '_')).slice(0, 63);
