import { buildProviderTargetEnv } from './services/api-proxy-env-config';
import { normalizeApiTargetScheme } from './host-env';
import type { WrapperConfig } from './types';
import type { ApiProxyUpstream } from './types/squid';
import { validateApiProxyPort } from './squid/validation';

/**
 * Use the same resolved targets as the sidecar, not the agent's rewritten URLs
 * or its domain allowlist. These exceptions never make a port globally safe.
 */
export function resolveApiProxyUpstreams(config: WrapperConfig): ApiProxyUpstream[] {
  if (!config.enableApiProxy) return [];
  const env = buildProviderTargetEnv(config);
  const targets = [
    env.OPENAI_API_TARGET,
    env.ANTHROPIC_API_TARGET,
    env.COPILOT_API_TARGET,
    env.GEMINI_API_TARGET,
    env.VERTEX_API_TARGET,
    process.env.GITHUB_API_URL,
  ];
  const endpoints: ApiProxyUpstream[] = [];
  for (const value of targets) {
    if (!value) continue;
    const target = normalizeApiTargetScheme(value);
    const parsed = new URL(target.startsWith('http://') ? target : `https://${target}`);
    const port = Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443));
    if (port === 80 || port === 443) continue;
    validateApiProxyPort(port);
    if (!endpoints.some(endpoint => endpoint.hostname === parsed.hostname && endpoint.port === port)) {
      endpoints.push({ hostname: parsed.hostname, port });
    }
  }
  return endpoints;
}
