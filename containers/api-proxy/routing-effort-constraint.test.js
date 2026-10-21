'use strict';

/**
 * Regression coverage for the optional `apiProxy.routing.allowedEfforts`
 * constraint (github/gh-aw-firewall#10424).
 *
 * A consuming engine may run only part of the routing effort vocabulary (for
 * example, Codex accepts `minimal` through `xhigh`). The constraint removes
 * unsupported model/effort arms before either planner request, so the router
 * never ranks an arm the engine would refuse to start.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRoutingCandidates } = require('./routing-candidates');
const { parseRoutingConfig } = require('./routing-config');
const { createRoutingController } = require('./routing-controller');
const { resetCopilotInteractionIdForTests } = require('./request-headers');
const { createProductionRoutingSession, createRoutingObserver } = require('./routing-runtime');

const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Copilot catalogue entries in the normalized shape routing-catalogue.js produces.
// The live catalogue reported for the run advertises `none` through `max` for the
// gpt-5.6-* models.
const GPT_5_6_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'].map(id => ({
  id,
  efforts: [...ALL_EFFORTS],
  protocols: ['responses', 'chat-completions'],
  contextWindow: 400_000,
}));
const CLAUDE_HAIKU_4_5 = {
  id: 'claude-haiku-4.5',
  efforts: [],
  protocols: ['chat-completions'],
  contextWindow: 200_000,
};

// Projection reconstructed from the supplied run summary (`rankedChoices`,
// `selectedModel`, `selectedEffort`, classification labels) into AWF's raw
// snake_case selection record shape. It is not a downloaded raw artifact.
const REPORTED_SELECTION_PROJECTION = Object.freeze({
  stage: 'selection',
  selected_model: 'github-copilot/gpt-5.6-luna',
  selected_effort: 'max',
  mode: 'balanced',
  labels: { task_type: 'fix', scope: 'subsystem', task_complexity: 'medium' },
  ranked_choices: [
    { model: 'github-copilot/gpt-5.6-luna', effort: 'max' },
    { model: 'github-copilot/gpt-5.6-sol', effort: 'medium' },
    { model: 'github-copilot/gpt-5.6-terra', effort: 'xhigh' },
    { model: 'github-copilot/gpt-5.6-sol', effort: 'high' },
    { model: 'github-copilot/gpt-5.6-sol', effort: 'xhigh' },
  ],
});

const CONVERSATION = [{ role: 'user', parts: [{ text: 'Fix the failing unit test.' }] }];
const CLASSIFICATION = {
  labels: REPORTED_SELECTION_PROJECTION.labels,
  mode: REPORTED_SELECTION_PROJECTION.mode,
};
const ROUTING_CONFIG = {
  objective: { goal: 'cost', mode: 'auto' },
  task: { conversationFile: '/run/awf-routing/input/conversation.json' },
};

function copyChoice(choice) {
  const copy = { id: choice.id, model: choice.model };
  if (Object.hasOwn(choice, 'effort')) copy.effort = choice.effort;
  return copy;
}

// Replays the supplied ranking over whatever the pool offers, dropping arms
// the pool no longer contains.
function replayReportedRanking(offered) {
  return REPORTED_SELECTION_PROJECTION.ranked_choices
    .map(ranked => offered.find(choice => choice.model === ranked.model && choice.effort === ranked.effort))
    .filter(Boolean)
    .map(copyChoice);
}

async function runRouting({ models = GPT_5_6_MODELS, allowedEfforts, rank = replayReportedRanking, observer } = {}) {
  const rawConfig = JSON.stringify({ ...ROUTING_CONFIG, ...(allowedEfforts ? { allowedEfforts } : {}) });
  const config = parseRoutingConfig(rawConfig);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-effort-constraint-'));
  const records = [];
  const recorder = { record: record => { records.push(record); observer?.record(record); } };
  const planner = {
    health: jest.fn(async () => 204),
    capabilities: jest.fn(async () => ({
      name: 'gh-aw-router',
      version: '1.0.0',
      routing_profiles: ['economy', 'balanced', 'robust'].map(mode => ({ goal: 'cost', mode })),
      execution_catalogue: { models: [] },
    })),
    classify: jest.fn(async request => ({
      system_prompt: 'classify the task',
      prompt: 'Fix the failing unit test.',
      ranked_choices: request.models.map(copyChoice),
    })),
    route: jest.fn(async request => ({ ranked_choices: rank(request.models.map(copyChoice)) })),
  };
  const executor = {
    execute: jest.fn(async () => ({
      statusCode: 200,
      body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(CLASSIFICATION) }), 'utf8'),
    })),
    checkBeforePrimary: jest.fn(async () => undefined),
  };
  const createController = () => createRoutingController({
    config,
    planner,
    catalogue: {
      getSnapshot: async () => ({ provider: 'copilot', configured: true, discovery: 'complete', models }),
    },
    loadConversation: async () => JSON.parse(JSON.stringify(CONVERSATION)),
    executor,
    observer: recorder,
  });
  const session = createProductionRoutingSession({ rawConfig, outputDir, createController, observer: recorder });
  const result = await session.start();
  fs.rmSync(outputDir, { recursive: true, force: true });
  return { session, result, records, planner };
}

const offeredEfforts = request => request.models.map(choice => choice.effort);
const selectionRecord = records => records.find(record => record.stage === 'selection');

describe('routing effort constraint', () => {
  it('codex_effort_constraint_excludes_none_and_max_before_ranking', async () => {
    const { result, records, planner } = await runRouting({ allowedEfforts: CODEX_EFFORTS });

    expect(result.ok).toBe(true);
    for (const phase of ['classify', 'route']) {
      expect(planner[phase]).toHaveBeenCalledTimes(1);
      const request = planner[phase].mock.calls[0][0];
      expect(request.models).toHaveLength(GPT_5_6_MODELS.length * CODEX_EFFORTS.length);
      expect(offeredEfforts(request)).not.toContain('none');
      expect(offeredEfforts(request)).not.toContain('max');
    }

    const selection = selectionRecord(records);
    expect(selection.ranked_choices).toEqual(REPORTED_SELECTION_PROJECTION.ranked_choices.slice(1));
    expect(selection.ranked_choices.map(choice => choice.effort)).not.toContain('none');
    expect(selection.ranked_choices).not.toContainEqual({ model: 'github-copilot/gpt-5.6-luna', effort: 'max' });
    expect(selection).toMatchObject({
      selected_model: 'github-copilot/gpt-5.6-sol',
      selected_effort: 'medium',
      allowed_efforts: CODEX_EFFORTS,
    });
    expect(CODEX_EFFORTS).toContain(result.selection.choice.effort);
    expect(result.selection).toMatchObject({
      choice: { model: 'github-copilot/gpt-5.6-sol', effort: 'medium' },
      wire_model: 'gpt-5.6-sol',
      endpoint: '/responses',
    });
  });

  it('omitted_effort_constraint_preserves_all_live_efforts', async () => {
    const { result, records, planner } = await runRouting();

    expect(result.ok).toBe(true);
    for (const phase of ['classify', 'route']) {
      const efforts = offeredEfforts(planner[phase].mock.calls[0][0]);
      expect(efforts).toHaveLength(GPT_5_6_MODELS.length * ALL_EFFORTS.length);
      expect([...new Set(efforts)].sort()).toEqual([...ALL_EFFORTS].sort());
    }

    const selection = selectionRecord(records);
    expect(selection).toMatchObject({
      selected_model: REPORTED_SELECTION_PROJECTION.selected_model,
      selected_effort: REPORTED_SELECTION_PROJECTION.selected_effort,
      ranked_choices: REPORTED_SELECTION_PROJECTION.ranked_choices,
      labels: REPORTED_SELECTION_PROJECTION.labels,
      mode: REPORTED_SELECTION_PROJECTION.mode,
    });
    expect(Object.hasOwn(selection, 'allowed_efforts')).toBe(false);
    expect(records.some(record => Object.hasOwn(record, 'allowed_efforts'))).toBe(false);
    expect(parseRoutingConfig(JSON.stringify(ROUTING_CONFIG))).not.toHaveProperty('allowedEfforts');
  });

  it('effort_constraint_exhaustion_returns_no_route', async () => {
    const models = [{
      id: 'gpt-5.3-codex',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      protocols: ['responses'],
      contextWindow: 400_000,
    }];
    const { session, result, records, planner } = await runRouting({ models, allowedEfforts: ['minimal'] });

    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({ code: 'no_route', retryable: false });
    expect(result.failure.detail).toContain('routing.allowedEfforts');
    expect(result.failure.detail).toContain('minimal');
    expect(planner.classify).not.toHaveBeenCalled();
    expect(planner.route).not.toHaveBeenCalled();
    expect(records.find(record => record.stage === 'failure')).toMatchObject({
      code: 'no_route',
      allowed_efforts: ['minimal'],
    });
    expect(session.getReflectState()).toEqual({
      status: 'failed',
      failure_code: 'no_route',
      allowed_efforts: ['minimal'],
      selection: null,
    });

    expect(() => buildRoutingCandidates({
      catalogue: { provider: 'copilot', configured: true, discovery: 'complete', models },
      allowedEfforts: ['minimal'],
    })).toThrow(expect.objectContaining({
      code: 'no_route',
      message: expect.stringContaining('routing.allowedEfforts constraint (minimal)'),
    }));
  });

  it('omitted_model_effort_remains_eligible_under_constraint', async () => {
    const { result, records, planner } = await runRouting({
      models: [...GPT_5_6_MODELS, CLAUDE_HAIKU_4_5],
      allowedEfforts: ['minimal'],
      rank: offered => offered.filter(choice => choice.model === 'github-copilot/claude-haiku-4.5'),
    });

    expect(result.ok).toBe(true);
    for (const phase of ['classify', 'route']) {
      const { models } = planner[phase].mock.calls[0][0];
      const haiku = models.filter(choice => choice.model === 'github-copilot/claude-haiku-4.5');
      expect(haiku).toHaveLength(1);
      expect(Object.hasOwn(haiku[0], 'effort')).toBe(false);
      expect(models.filter(choice => choice !== haiku[0]).map(choice => choice.effort))
        .toEqual(GPT_5_6_MODELS.map(() => 'minimal'));
    }
    expect(Object.hasOwn(result.selection.choice, 'effort')).toBe(false);
    expect(result.selection).toMatchObject({ wire_model: 'claude-haiku-4.5', endpoint: '/chat/completions' });
    expect(selectionRecord(records)).toMatchObject({ selected_effort: null, allowed_efforts: ['minimal'] });

    // Even a constraint with no reasoning-effort overlap keeps the omitted-effort arm.
    const pool = buildRoutingCandidates({
      catalogue: { provider: 'copilot', configured: true, discovery: 'complete', models: [CLAUDE_HAIKU_4_5] },
      allowedEfforts: ['none'],
    });
    expect(pool.choices).toEqual([{ id: 'choice-0001', model: 'github-copilot/claude-haiku-4.5' }]);
    expect(Object.hasOwn(pool.byId['choice-0001'], 'effort')).toBe(false);
  });

  it('config_schema_rejects_unknown_constrained_effort', () => {
    const parse = allowedEfforts => parseRoutingConfig(JSON.stringify({ ...ROUTING_CONFIG, allowedEfforts }));

    expect(parse([...CODEX_EFFORTS]).allowedEfforts).toEqual(CODEX_EFFORTS);
    expect(Object.isFrozen(parse(['max']).allowedEfforts)).toBe(true);
    expect(() => parse(['medium', 'ultra'])).toThrow('routing.allowedEfforts[1] is not a supported effort');
    expect(() => parse(['MAX'])).toThrow('routing.allowedEfforts[0] is not a supported effort');
    expect(() => parse([null])).toThrow('routing.allowedEfforts[0] is not a supported effort');
    expect(() => parse(['low', 'low'])).toThrow('routing.allowedEfforts[1] is a duplicate effort');
    expect(() => parse([])).toThrow('routing.allowedEfforts must be a non-empty array');
    expect(() => parse('low')).toThrow('routing.allowedEfforts must be a non-empty array');
    expect(() => parse(null)).toThrow('routing.allowedEfforts must be a non-empty array');
  });

  describe('effort_constraint_is_persisted_and_reflected', () => {
    let directory;
    let saved;
    const keys = ['AWF_TOKEN_LOG_DIR', 'AWF_VERSION'];

    beforeEach(() => {
      saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-effort-logs-'));
      process.env.AWF_TOKEN_LOG_DIR = directory;
      process.env.AWF_VERSION = '1.2.3';
      resetCopilotInteractionIdForTests();
    });

    afterEach(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      resetCopilotInteractionIdForTests();
      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('effort_constraint_is_persisted_and_reflected', async () => {
      const observer = createRoutingObserver(() => {});
      const { session, result } = await runRouting({ allowedEfforts: CODEX_EFFORTS, observer });
      expect(result.ok).toBe(true);

      const persisted = fs.readFileSync(path.join(directory, 'model-routing.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      const classification = persisted.find(record => record.stage === 'classification');
      const selection = persisted.find(record => record.stage === 'selection');
      expect(classification).toMatchObject({ event: 'model_routing', allowed_efforts: CODEX_EFFORTS });
      expect(selection).toMatchObject({
        event: 'model_routing',
        allowed_efforts: CODEX_EFFORTS,
        selected_model: 'github-copilot/gpt-5.6-sol',
        selected_effort: 'medium',
      });
      // An excluded arm is outside allowed_efforts; a lower-ranked arm is inside it.
      expect(selection.allowed_efforts).not.toContain('max');
      expect(selection.ranked_choices).toContainEqual({ model: 'github-copilot/gpt-5.6-sol', effort: 'xhigh' });

      expect(session.getReflectState()).toEqual({
        status: 'selected',
        allowed_efforts: CODEX_EFFORTS,
        selection: {
          provider: 'copilot',
          model: 'github-copilot/gpt-5.6-sol',
          wire_model: 'gpt-5.6-sol',
          effort: 'medium',
          endpoint: '/responses',
        },
      });
    });
  });
});
