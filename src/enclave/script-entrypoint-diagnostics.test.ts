import { spawnSync } from 'child_process';
import * as path from 'path';

const entrypoint = path.resolve(__dirname, '../../containers/enclave/script-entrypoint.py');
const harness = String.raw`
import importlib.util
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("script_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = os.environ["SCENARIO"]

def operation(phase):
    def run(*args, **kwargs):
        if scenario == phase:
            raise PermissionError(13, "PRIVATE_SCRIPT PRIVATE_TOKEN /private/repository")
        if phase == "script-execute":
            if scenario == "exit-zero":
                raise SystemExit(0)
            print("true")
    return run

with patch.object(module.shutil, "copytree", operation("seed-copy")), \
     patch.object(module.Path, "symlink_to", operation("output-link")), \
     patch.object(module.os, "chdir", operation("working-directory")), \
     patch.object(module.runpy, "run_path", operation("script-execute")):
    try:
        module.main()
    except OSError:
        raise SystemExit(1)
`;

describe('script enclave guest lifecycle diagnostics', () => {
  it.each(['success', 'exit-zero', 'seed-copy', 'output-link', 'working-directory', 'script-execute'])(
    'records bounded stderr phases for %s without changing script stdout or exit status', scenario => {
      const result = spawnSync('python3', ['-c', harness], {
        encoding: 'utf8',
        env: { ...process.env, ENTRYPOINT: entrypoint, SCENARIO: scenario, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const success = scenario === 'success' || scenario === 'exit-zero';
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(success ? 0 : 1);
      expect(result.stdout).toBe(scenario === 'success' ? 'true\n' : '');
      const records = result.stderr.trim().split('\n').map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ component: 'enclave-script', phase: 'startup', status: 'started' });
      expect(records[records.length - 1]).toMatchObject({
        phase: success ? 'script-execute' : scenario,
        status: success ? 'passed' : 'failed',
        ...(!success ? { errorType: 'PermissionError', code: 'EACCES' } : {}),
      });
      expect(records.length).toBeLessThanOrEqual(10);
      expect(result.stderr).not.toMatch(/PRIVATE_|\/private\/|TOKEN/);
      for (const record of records) expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    },
  );
});
