import { resolveApiProxyUpstreams } from './api-proxy-upstream-endpoints';
import { buildProviderTargetEnv } from './services/api-proxy-env-config';
import { generateSquidConfig, generatePolicyManifest } from './squid-config';
import { baseConfig } from './test-helpers/docker-test-fixtures.test-utils';
import type { WrapperConfig } from './types';

const config: WrapperConfig = {
  ...baseConfig, workDir: '/tmp/awf-provider-port-test',
  enableApiProxy: true, networkIsolation: true,
};

describe('configured provider upstream ports', () => {
  it.each([
    ['http://host.docker.internal:11434/v1', 'http://host.docker.internal:11434', 11434],
    ['https://gateway.example:8443/v1', 'gateway.example:8443', 8443],
  ])('preserves %s through runner routing and the Squid exception', (url, target, port) => {
    const cfg = { ...config, additionalEnv: { COPILOT_PROVIDER_BASE_URL: url } };
    const env = buildProviderTargetEnv(cfg);
    expect(env.COPILOT_API_TARGET).toBe(target);
    expect(env.COPILOT_API_BASE_PATH).toBe('/v1');
    expect(resolveApiProxyUpstreams(cfg)).toEqual([{
      hostname: new URL(url).hostname, port,
    }]);
  });

  it('uses the effective explicit target, not an overridden provider URL', () => {
    expect(resolveApiProxyUpstreams({
      ...config, copilotApiTarget: 'https://explicit.example:9443',
      copilotProviderBaseUrl: 'http://ignored.example:11434/v1',
    })).toEqual([{ hostname: 'explicit.example', port: 9443 }]);
  });

  it('handles every provider, deduplicates pairs, and leaves default ports unchanged', () => {
    expect(resolveApiProxyUpstreams({
      ...config,
      openaiApiTarget: 'gateway.example:8443',
      anthropicApiTarget: 'https://gateway.example:8443',
      copilotApiTarget: 'http://host.docker.internal:11434',
      geminiApiTarget: 'https://default.example:443',
      vertexApiTarget: 'http://default.example:80',
    })).toEqual([
      { hostname: 'gateway.example', port: 8443 },
      { hostname: 'host.docker.internal', port: 11434 },
    ]);
  });

  it('preserves a secret-backed HTTPS port through runner routing', () => {
    const name = 'AWF_TEST_PRIVATE_PROVIDER';
    const previous = process.env.AWF_TEST_PRIVATE_PROVIDER;
    process.env.AWF_TEST_PRIVATE_PROVIDER = 'https://private.example:8443/v1';
    try {
      const cfg = { ...config, openaiBaseUrlEnv: name };
      expect(buildProviderTargetEnv(cfg)).toMatchObject({
        OPENAI_API_TARGET: 'private.example:8443', OPENAI_API_BASE_PATH: '/v1',
      });
      expect(resolveApiProxyUpstreams(cfg)).toEqual([{ hostname: 'private.example', port: 8443 }]);
    } finally {
      if (previous === undefined) delete process.env.AWF_TEST_PRIVATE_PROVIDER;
      else process.env.AWF_TEST_PRIVATE_PROVIDER = previous;
    }
  });

  it('adds no exceptions when the API proxy is disabled', () => {
    expect(resolveApiProxyUpstreams({
      ...config, enableApiProxy: false, copilotApiTarget: 'http://host:11434',
    })).toEqual([]);
  });

  it.each(['ftp://host:11434/v1', 'file:///tmp/provider', 'http://host:65536/v1'])('rejects %s', url => {
    expect(() => resolveApiProxyUpstreams({ ...config, copilotProviderBaseUrl: url })).toThrow();
  });

  it('does not make dangerous service ports safe', () => {
    expect(() => resolveApiProxyUpstreams({ ...config, copilotApiTarget: 'http://host:22' }))
      .toThrow(/blocked for security reasons/);
  });
});

describe('API-proxy-only Squid exceptions', () => {
  const squid = {
    domains: ['agent.example'], port: 3128, apiProxyIp: '172.30.0.30',
    apiProxyUpstreams: [
      { hostname: 'host.docker.internal', port: 11434 },
      { hostname: 'gateway.example', port: 8443 },
    ],
  };

  it('places exact source + host + port conjunctions before unsafe-port denials', () => {
    const text = generateSquidConfig(squid);
    expect(text).toContain('acl api_upstream_source src 172.30.0.30/32');
    expect(text).toContain('acl api_upstream_0_host dstdomain -n host.docker.internal');
    expect(text).toContain('acl api_upstream_0_port port 11434');
    expect(text).toContain('acl api_upstream_1_host dstdomain -n gateway.example');
    expect(text).toContain('acl api_upstream_1_port port 8443');
    const firstRule = 'http_access allow api_upstream_source api_upstream_0_host api_upstream_0_port';
    expect(text.indexOf(firstRule)).toBeLessThan(text.indexOf('http_access deny !Safe_ports'));
    expect(text).not.toContain('acl Safe_ports port 11434');
    expect(text).not.toContain('acl Safe_ports port 8443');
    expect(text.indexOf('http_access deny !Safe_ports')).toBeLessThan(text.indexOf('http_access allow from_api_proxy'));
    expect(text).toContain('http_access deny dst_ipv4');
    expect(text).toContain('http_access deny dst_ipv6');
    expect(text).not.toContain('dstdomain .host.docker.internal');
  });

  it('cannot mix a configured hostname with another upstream port or source', () => {
    const text = generateSquidConfig(squid);
    const rules = text.split('\n').filter(line => line.startsWith('http_access allow api_upstream_source'));
    expect(rules).toEqual([
      'http_access allow api_upstream_source api_upstream_0_host api_upstream_0_port',
      'http_access allow api_upstream_source api_upstream_1_host api_upstream_1_port',
    ]);
    expect(generateSquidConfig({ ...squid, apiProxyIp: undefined })).not.toContain('acl api_upstream_source');
    const manifest = generatePolicyManifest(squid);
    const rule = manifest.rules.find(entry => entry.id === 'allow-api-upstream-0')!;
    expect(rule.domains).toEqual([]);
    expect(rule.order).toBeLessThan(manifest.rules.find(entry => entry.id === 'deny-unsafe-ports')!.order);
  });

  it('matches configured raw IP literals without reverse-DNS or agent exceptions', () => {
    const text = generateSquidConfig({
      ...squid, apiProxyUpstreams: [{ hostname: '172.17.0.1', port: 11434 }],
    });
    expect(text).toContain('acl api_upstream_0_host dstdom_regex ^172\\.17\\.0\\.1$');
    expect(text).toContain('http_access deny dst_ipv4');
    const ipv6 = generateSquidConfig({
      ...squid, apiProxyUpstreams: [{ hostname: '[::1]', port: 11434 }],
    });
    expect(ipv6).toContain('acl api_upstream_0_host dstdom_regex ^\\[?::1\\]?$');
  });

  it.each(['.example.com', '*.example.com', 'host:1234', 'host/path', 'host\nhttp_access allow all'])(
    'rejects unsafe or non-exact hostname %s', hostname => {
      expect(() => generateSquidConfig({
        ...squid, apiProxyUpstreams: [{ hostname, port: 11434 }],
      })).toThrow();
    },
  );
});
