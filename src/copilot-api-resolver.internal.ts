/**
 * Parse a provider base URL into a URL object, handling missing schemes.
 * Returns undefined if empty; rejects malformed or unsupported URLs.
 */
function parseProviderBaseUrl(providerBaseUrl: string | undefined): URL | undefined {
  const trimmed = providerBaseUrl?.trim();
  if (!trimmed) return undefined;

  const candidate = trimmed.includes('://')
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported Copilot provider URL scheme');
    }
    return parsed;
  } catch {
    throw new Error('Invalid Copilot provider base URL; expected an HTTP(S) URL or hostname');
  }
}

/**
 * Derive a Copilot API authority and explicit HTTP scheme from the base URL.
 */
export function deriveCopilotApiTargetFromProviderBaseUrl(
  providerBaseUrl: string | undefined
): string | undefined {
  const parsed = parseProviderBaseUrl(providerBaseUrl);
  if (!parsed) return undefined;
  return parsed.protocol === 'http:' ? `http://${parsed.host}` : parsed.host;
}

/**
 * Derive a Copilot API base-path prefix from COPILOT_PROVIDER_BASE_URL.
 * Returns undefined when the value is empty, invalid, or has no path.
 */
export function deriveCopilotApiBasePathFromProviderBaseUrl(
  providerBaseUrl: string | undefined
): string | undefined {
  const url = parseProviderBaseUrl(providerBaseUrl);
  if (!url) return undefined;

  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') return undefined;
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}
