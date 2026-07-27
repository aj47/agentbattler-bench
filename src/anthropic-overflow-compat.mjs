import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const OVERFLOW_PATTERN = /(?:context(?: window| length)?(?: is)?(?: exceeded| overflow| too (?:large|long))|context_length_exceeded|context_too_large|maximum context|prompt (?:is )?too long|too many (?:input )?tokens)/i;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function bodyText(body) {
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return String(body ?? ''); }
}

export function isContextOverflowResponse(status, body) {
  return status >= 400 && status !== 413 && OVERFLOW_PATTERN.test(bodyText(body));
}

export function normalizeContextOverflow(status, body, requestId = null) {
  if (!isContextOverflowResponse(status, body)) return null;
  let parsed = null;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* Preserve the original text below. */ }
  const upstreamMessage = parsed?.error?.message ?? parsed?.message ?? bodyText(body);
  return {
    status: 400,
    body: {
      type: 'error',
      error: { type: 'invalid_request_error', message: `Prompt is too long: the input exceeds the model context window. Upstream response: ${String(upstreamMessage).slice(0, 1_000)}` },
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

function forwardedHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

export async function startAnthropicOverflowCompat({ upstreamBaseUrl, listenHost = '127.0.0.1', advertisedHost = listenHost }) {
  const upstream = new URL(upstreamBaseUrl.endsWith('/') ? upstreamBaseUrl : `${upstreamBaseUrl}/`);
  const stats = { requests: 0, translatedContextOverflows: 0 };
  const server = createServer(async (request, response) => {
    stats.requests += 1;
    try {
      const target = new URL(request.url?.replace(/^\//, '') ?? '', upstream);
      const headers = { ...request.headers }; delete headers.host; delete headers['content-length'];
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request,
        duplex: 'half',
      });
      if (upstreamResponse.status >= 400) {
        const original = await upstreamResponse.text();
        const normalized = normalizeContextOverflow(upstreamResponse.status, original, upstreamResponse.headers.get('request-id') ?? upstreamResponse.headers.get('x-request-id'));
        if (normalized) {
          stats.translatedContextOverflows += 1;
          response.writeHead(normalized.status, { 'content-type': 'application/json', 'x-agentbattler-overflow-normalized': '1' });
          response.end(JSON.stringify(normalized.body));
          return;
        }
        response.writeHead(upstreamResponse.status, forwardedHeaders(upstreamResponse.headers));
        response.end(original);
        return;
      }
      response.writeHead(upstreamResponse.status, forwardedHeaders(upstreamResponse.headers));
      if (upstreamResponse.body) Readable.fromWeb(upstreamResponse.body).pipe(response); else response.end();
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `AgentBattler overflow compatibility proxy failed: ${error.message}` } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, listenHost, resolve); });
  const address = server.address();
  const baseUrl = `http://${advertisedHost}:${address.port}`;
  return {
    baseUrl,
    stats,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
