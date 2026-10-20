import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { rootCertificates } from 'node:tls';

type Policy = typeof import('./tls-trust-policy');
const trusted = rootCertificates.find(pem => new X509Certificate(pem).subject.includes('ISRG Root X1'))!;
const blocked = readFileSync(path.resolve(__dirname, '../scripts/security/fixtures/emsign-ecc-g3.pem'), 'utf8').trim();
const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS;

function load(options: {
  legacy?: boolean;
  defaults?: string[];
  extra?: string;
  extraError?: Error;
  setter?: boolean;
} = {}) {
  const nativeContext = {};
  const createSecureContext = jest.fn().mockReturnValue(nativeContext);
  const setDefaultCACertificates = jest.fn();
  const getCACertificates = jest.fn().mockReturnValue(options.defaults ?? [trusted, blocked]);
  const read = jest.fn(() => {
    if (options.extraError) throw options.extraError;
    return options.extra;
  });
  if (options.extra !== undefined || options.extraError) process.env.NODE_EXTRA_CA_CERTS = '/private-ca.pem';
  jest.doMock('node:tls', () => ({
    rootCertificates: options.defaults ?? [trusted, blocked],
    getCACertificates: options.legacy ? undefined : getCACertificates,
    setDefaultCACertificates: options.legacy || options.setter === false ? undefined : setDefaultCACertificates,
    createSecureContext,
  }));
  jest.doMock('node:fs', () => ({ readFileSync: read }));
  let policy!: Policy;
  let tls!: typeof import('node:tls');
  jest.isolateModules(() => {
    policy = jest.requireActual<Policy>('./tls-trust-policy');
    tls = jest.requireMock<typeof import('node:tls')>('node:tls');
  });
  return { policy, tls, createSecureContext, setDefaultCACertificates, getCACertificates, read, nativeContext };
}

beforeEach(() => { delete process.env.NODE_EXTRA_CA_CERTS; });
afterEach(() => {
  jest.dontMock('node:tls');
  jest.dontMock('node:fs');
  if (originalExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = originalExtraCa;
});

test('filters modern defaults and extra roots and installs the policy only once', () => {
  const f = load({ extra: blocked + '\n' + trusted });
  expect(f.getCACertificates).toHaveBeenCalledWith('default');
  expect(f.read).toHaveBeenCalledWith('/private-ca.pem', 'utf8');
  expect(f.setDefaultCACertificates).toHaveBeenCalledWith([trusted, trusted]);
  f.policy.applyTlsTrustPolicy();
  expect(f.setDefaultCACertificates).toHaveBeenCalledTimes(1);
});

test.each([false, true])('default and null CA options use sanitized defaults (legacy=%s)', legacy => {
  const f = load({ legacy });
  for (const options of [undefined, { ca: null }]) {
    // Node accepts ca:null at runtime, despite its declaration excluding null.
    const result = options === undefined
      ? f.tls.createSecureContext()
      : Reflect.apply(f.tls.createSecureContext, f.tls, [options]);
    expect(result).toBe(f.nativeContext);
    expect(f.createSecureContext).toHaveBeenLastCalledWith({ ca: [trusted] });
  }
  expect(f.setDefaultCACertificates).toHaveBeenCalledTimes(legacy ? 0 : 1);
});

test('filters explicit CA strings, buffers and arrays without dropping other options', () => {
  const f = load({ setter: false });
  for (const ca of [trusted + '\n' + blocked, Buffer.from(trusted), [Buffer.from(blocked), trusted]]) {
    f.tls.createSecureContext({ ca, minVersion: 'TLSv1.2' });
    expect(f.createSecureContext).toHaveBeenLastCalledWith({ ca: [trusted], minVersion: 'TLSv1.2' });
  }
  f.tls.createSecureContext({ ca: blocked });
  expect(f.createSecureContext).toHaveBeenLastCalledWith({ ca: [] });
  expect(f.policy.filterCaCertificates(' \n')).toEqual([]);
});

test.each([
  ['not a certificate', /PEM CERTIFICATE/],
  ['-----BEGIN TRUSTED CERTIFICATE-----\ninvalid\n-----END TRUSTED CERTIFICATE-----', /PEM CERTIFICATE/],
  ['-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----', /./],
])('rejects malformed explicit trust: %s', (ca, error) => {
  const f = load();
  expect(() => f.tls.createSecureContext({ ca })).toThrow(error);
  expect(f.createSecureContext).not.toHaveBeenCalled();
});

test.each([false, true])('rejects an entirely distrusted default store (legacy=%s)', legacy => {
  expect(() => load({ legacy, defaults: [blocked] })).toThrow('empty default CA store');
});

test('fails closed when an explicit extra CA file cannot be read', () => {
  expect(() => load({ extraError: new Error('private CA is unreadable') })).toThrow('private CA is unreadable');
});
