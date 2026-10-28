#!/usr/bin/env bash
set -euo pipefail
umask 077

results_dir="${1:-/tmp/gh-aw/build-test}"
mkdir -p "$results_dir"
results_dir="$(cd "$results_dir" && pwd)"
rm -f "$results_dir/results.json"
work_dir="$(mktemp -d "$results_dir/run-XXXXXX")"
export DOTNET_CLI_HOME="$work_dir/dotnet"
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export XDG_RUNTIME_DIR="$work_dir/runtime"
export BUN_INSTALL="$work_dir/bun"
export DENO_INSTALL="$work_dir/deno"
export PATH="$BUN_INSTALL/bin:$DENO_INSTALL/bin:$PATH"
mkdir -p "$DOTNET_CLI_HOME" "$XDG_RUNTIME_DIR" "$work_dir/m2"

cat > "$work_dir/m2/settings.xml" <<'SETTINGS'
<settings>
  <proxies>
    <proxy>
      <id>awf-http</id><active>true</active><protocol>http</protocol>
      <host>squid-proxy</host><port>3128</port>
    </proxy>
    <proxy>
      <id>awf-https</id><active>true</active><protocol>https</protocol>
      <host>squid-proxy</host><port>3128</port>
    </proxy>
  </proxies>
</settings>
SETTINGS
export MAVEN_SETTINGS="$work_dir/m2/settings.xml"
export MAVEN_REPO="$work_dir/m2/repository"
maven() {
  mvn -s "$MAVEN_SETTINGS" "-Dmaven.repo.local=$MAVEN_REPO" "$@"
}
export -f maven
records="$work_dir/projects.jsonl"
: > "$records"

record() {
  node - "$records" "$ecosystem" "$project" "$1" "$2" "$3" <<'NODE'
const fs = require('fs');
const [file, ecosystem, project, status, stepsPassed, logFile] = process.argv.slice(2);
const log = fs.readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
// Formats emitted by Bun, Deno, Rust, Maven, and common Node test runners.
const passed = [...log.matchAll(/(?:^|\n)\s*(\d+)\s+(?:pass|passing)\b|(\d+) passed\b|Tests run: (\d+), Failures: (\d+), Errors: (\d+)/g)];
let testsPassed = null;
let testsFailed = null;
if (passed.length) {
  const last = passed[passed.length - 1];
  testsPassed = Number(last[1] ?? last[2] ?? (Number(last[3]) - Number(last[4]) - Number(last[5])));
  const failed = [...log.matchAll(/(?:^|\n)\s*(\d+)\s+(?:fail|failing)\b|(\d+) failed\b/g)].pop();
  testsFailed = last[3] !== undefined ? Number(last[4]) + Number(last[5])
    : failed ? Number(failed[1] ?? failed[2]) : status === 'PASS' ? 0 : null;
}
if (ecosystem === 'rust') {
  const suites = [...log.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  if (suites.length) {
    testsPassed = suites.reduce((sum, suite) => sum + Number(suite[1]), 0);
    testsFailed = suites.reduce((sum, suite) => sum + Number(suite[2]), 0);
  }
}
if (ecosystem === 'go') {
  const tests = log.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter(event => event.Test && ['pass', 'fail'].includes(event.Action));
  if (tests.length) {
    testsPassed = tests.filter(test => test.Action === 'pass').length;
    testsFailed = tests.filter(test => test.Action === 'fail').length;
  }
}
fs.appendFileSync(file, JSON.stringify({
  ecosystem, project, status, stepsPassed: Number(stepsPassed),
  testsPassed, testsFailed,
  errorTail: status === 'PASS' ? '' : log.slice(-2000),
}) + '\n');
NODE
}

run_project() {
  project="$1"
  shift
  local log="$work_dir/$ecosystem-$project.log" passed=0
  : > "$log"
  if [[ "$clone_status" != PASS ]]; then
    record CLONE_FAILED 0 "$clone_log"
    return
  fi
  if [[ "$install_status" != PASS ]]; then
    record INSTALL_FAILED 0 "$install_log"
    return
  fi
  for command in "$@"; do
    if (cd "$repo_dir/$project" && bash -o pipefail -c "$command") >> "$log" 2>&1; then
      passed=$((passed + 1))
    else
      record FAIL "$passed" "$log"
      return
    fi
  done
  record PASS "$passed" "$log"
}

for ecosystem in bun cpp deno dotnet go java node rust; do
  repo_dir="$work_dir/test-$ecosystem"
  clone_log="$work_dir/$ecosystem-clone.log"
  clone_status=PASS
  if ! git clone --depth 1 "https://github.com/Mossaka/gh-aw-firewall-test-$ecosystem.git" "$repo_dir" > "$clone_log" 2>&1; then
    clone_status=CLONE_FAILED
  fi
  install_status=PASS
  install_log="$work_dir/$ecosystem-install.log"
  if [[ "$clone_status" == PASS ]]; then
    case "$ecosystem" in
      bun)
        if ! (curl -fsSL https://bun.sh/install | bash) > "$install_log" 2>&1; then
          install_status=INSTALL_FAILED
        fi
        ;;
      deno)
        if ! (curl -fsSL https://deno.land/install.sh | sh) > "$install_log" 2>&1; then
          install_status=INSTALL_FAILED
        fi
        ;;
    esac
  fi
  case "$ecosystem" in
    bun)
      for name in elysia hono; do run_project "$name" 'bun install' 'bun test'; done ;;
    cpp)
      for name in fmt json; do run_project "$name" 'cmake -S . -B build' 'make -C build'; done ;;
    deno)
      for name in oak std; do run_project "$name" 'deno test'; done ;;
    dotnet)
      for name in hello-world json-parse; do run_project "$name" 'dotnet restore' 'dotnet build' 'dotnet run'; done ;;
    go)
      for name in color env uuid; do run_project "$name" 'go mod download' 'go test -json ./...'; done ;;
    java)
      for name in gson caffeine; do
        run_project "$name" 'maven compile' 'maven test'
      done ;;
    node)
      for name in clsx execa p-limit; do run_project "$name" 'npm install' 'npm test'; done ;;
    rust)
      for name in fd zoxide; do run_project "$name" 'cargo build' 'cargo test'; done ;;
  esac
done

node - "$records" "$results_dir/results.json" <<'NODE'
const fs = require('fs');
const [records, output] = process.argv.slice(2);
const projects = fs.readFileSync(records, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const ecosystems = [...new Set(projects.map(project => project.ecosystem))];
const results = {
  status: projects.every(project => project.status === 'PASS') ? 'PASS' : 'FAIL',
  projectsPassed: projects.filter(project => project.status === 'PASS').length,
  projectsTotal: projects.length,
  ecosystemsPassed: ecosystems.filter(name =>
    projects.filter(project => project.ecosystem === name).every(project => project.status === 'PASS')).length,
  ecosystemsTotal: ecosystems.length,
  allClonesFailed: projects.every(project => project.status === 'CLONE_FAILED'),
  projects,
};
fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
process.exitCode = results.status === 'PASS' ? 0 : 1;
NODE
