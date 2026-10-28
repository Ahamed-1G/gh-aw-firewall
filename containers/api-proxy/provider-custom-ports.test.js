'use strict';

const http = require('http');
const net = require('net');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createCopilotAdapter } = require('./providers/copilot');
const { createAdapterMethods } = require('./adapter-factory');

jest.mock('./token-tracker', () => ({ trackTokenUsage: jest.fn(), trackWebSocketTokenUsage: jest.fn() }));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('provider custom-port routing', () => {
  it.each([
    ['http://host.docker.internal:11434/v1', 'host.docker.internal:11434', 'http'],
    ['https://gateway.example:8443/v1', 'gateway.example:8443', 'https'],
    ['https://gateway.example:443/v1', 'gateway.example', 'https'],
    ['http://gateway.example:80/v1', 'gateway.example', 'http'],
  ])('retains %s in inference, discovery, validation and reflection', (url, authority, scheme) => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_BASE_URL: url, COPILOT_PROVIDER_API_KEY: 'test-key',
    });
    expect(adapter.getTargetHost()).toBe(authority);
    expect(adapter.getTargetScheme()).toBe(scheme);
    expect(adapter.getBasePath()).toBe('/v1');
    expect(adapter.getModelsFetchConfig().url).toBe(`${scheme}://${authority}/v1/models`);
    expect(adapter.getReflectionInfo()).toMatchObject({
      models_url: 'http://api-proxy:10002/v1/models',
    });
    const methods = createAdapterMethods({
      apiKey: 'test-key',
      rawTarget: scheme === 'http' ? `http://${authority}` : authority,
      provider: 'example', port: 10000, basePath: '/v1',
      validationPath: '/v1/models', modelsPath: '/v1/models',
    });
    expect(methods.getValidationProbe().url).toBe(`${scheme}://${authority}/v1/models`);
    expect(methods.getModelsFetchConfig().url).toBe(`${scheme}://${authority}/v1/models`);
  });

  it('sends discovery and inference through CONNECT to port 11434, preserving /v1', async () => {
    const received = [];
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, host: req.headers.host, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'GET' ? '{"data":[{"id":"local-model"}]}' : '{"choices":[]}');
      });
    });
    const connects = [];
    const sockets = new Set();
    const squid = http.createServer();
    squid.on('connect', (req, socket, head) => {
      connects.push(req.url);
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const tunnel = net.connect(upstream.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) tunnel.write(head);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
      });
      sockets.add(tunnel);
      tunnel.on('close', () => sockets.delete(tunnel));
      tunnel.on('error', () => socket.destroy());
      socket.on('error', () => tunnel.destroy());
    });
    let proxyAgent;
    let frontend;
    try {
      await listen(upstream);
      const squidPort = await listen(squid);
      const proxyUrl = `http://127.0.0.1:${squidPort}`;
      proxyAgent = new HttpsProxyAgent(proxyUrl);
      jest.doMock('./http-client', () => ({ HTTPS_PROXY: proxyUrl, proxyAgent }));
      const { proxyRequest } = require('./proxy-request');
      const { fetchJson } = require('./model-discovery');
      const adapter = createCopilotAdapter({
        COPILOT_PROVIDER_BASE_URL: 'http://host.docker.internal:11434/v1',
        COPILOT_PROVIDER_API_KEY: 'test-key',
      });
      const discovery = adapter.getModelsFetchConfig();
      expect(await fetchJson(discovery.url, discovery.opts, 2000)).toEqual({
        data: [{ id: 'local-model' }],
      });
      frontend = http.createServer(async (req, res) => {
        proxyRequest(req, res, adapter.getTargetHost(), await adapter.getAuthHeaders(req),
          'copilot', adapter.getBasePath(), adapter.bodyTransform, null, adapter.getTargetScheme());
      });
      const frontendPort = await listen(frontend);
      for (const path of ['/chat/completions', '/v1/chat/completions']) {
        await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1', port: frontendPort, path, method: 'POST',
            headers: { 'Content-Type': 'application/json' }, agent: false,
          }, res => {
            res.resume();
            res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
          });
          req.on('error', reject);
          req.end('{"model":"local-model","messages":[]}');
        });
      }
      expect(connects).toEqual(Array(3).fill('host.docker.internal:11434'));
      expect(received.map(({ method, url, host }) => ({ method, url, host }))).toEqual([
        { method: 'GET', url: '/v1/models', host: 'host.docker.internal:11434' },
        { method: 'POST', url: '/v1/chat/completions', host: 'host.docker.internal:11434' },
        { method: 'POST', url: '/v1/chat/completions', host: 'host.docker.internal:11434' },
      ]);
    } finally {
      proxyAgent?.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.all([frontend, squid, upstream].filter(Boolean).map(server =>
        new Promise(resolve => server.close(resolve))));
      jest.dontMock('./http-client');
    }
  });
});
