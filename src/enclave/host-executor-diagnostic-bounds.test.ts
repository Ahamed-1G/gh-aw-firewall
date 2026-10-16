/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('../../containers/enclave/mcp-server/host-executor-client', () => ({
  createHostExecutorClient: () => ({
    status: async () => ({ ok: false, error: 'unknown-invocation' }),
  }),
}));
const { createHostExecutorRunner } = require('../../containers/enclave/mcp-server/host-executor-runner');
/* eslint-enable @typescript-eslint/no-require-imports */

it('bounds protected broker diagnostics with one limit marker without closing admissions', async () => {
  const audit = { lifecycle: jest.fn() };
  const runner = createHostExecutorRunner({
    executorBackend: 'cloud-hypervisor', entryId: 'script',
  }, { audit });
  for (let i = 0; i < 2100; i++) await runner.assertAvailable();
  expect(audit.lifecycle).toHaveBeenCalledTimes(4097);
  expect(audit.lifecycle.mock.calls[4096]).toEqual(['host-executor', expect.objectContaining({
    sequence: 4097, phase: 'diagnostics', status: 'limit-reached',
  })]);
  await expect(runner.reconcileRun()).resolves.toBeUndefined();
});
