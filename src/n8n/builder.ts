// Small builder for n8n workflow JSON (n8n 1.x/2.x format). Workflows are
// generated from code so all 16 stay consistent, readable and reviewable.
import { createHash } from 'node:crypto';

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  webhookId?: string;
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
  notes?: string;
  notesInFlow?: boolean;
  alwaysOutputData?: boolean;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }>;
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  meta: Record<string, unknown>;
  tags: Array<{ id: string; name: string }>;
  versionId: string;
}

export const CREDENTIALS = {
  coreApi: { id: 'apxCredCoreApi01', name: 'ApexWeb Core API' },
  webhook: { id: 'apxCredWebhook01', name: 'ApexWeb Webhook Secret' },
};

/** Deterministic UUID-shaped id so regenerating produces stable diffs. */
export function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class WorkflowBuilder {
  readonly wf: N8nWorkflow;
  #coreUrl: string;

  constructor(id: string, name: string, coreUrl: string, opts: { active?: boolean; tags?: string[] } = {}) {
    this.#coreUrl = coreUrl.replace(/\/+$/, '');
    this.wf = {
      id,
      name,
      active: opts.active ?? false,
      isArchived: false,
      nodes: [],
      connections: {},
      settings: {
        executionOrder: 'v1',
        saveDataSuccessExecution: 'all',
        saveDataErrorExecution: 'all',
        saveExecutionProgress: true,
        saveManualExecutions: true,
        callerPolicy: 'workflowsFromSameOwner',
        timezone: 'UTC',
      },
      pinData: {},
      meta: { templateCredsSetupCompleted: true, generatedBy: 'apexweb-os src/n8n/generate.ts' },
      // Stable tag ids let n8n reuse one tag row across workflows on import.
      tags: (opts.tags ?? ['apexweb']).map((t) => ({ id: `apxTag${t.replace(/[^a-z0-9]/gi, '').slice(0, 10).padEnd(10, '0')}`, name: t })),
      versionId: stableUuid(`${id}:version`),
    };
  }

  add(node: Omit<N8nNode, 'id'> & { id?: string }): string {
    if (this.wf.nodes.some((n) => n.name === node.name)) throw new Error(`Duplicate node name ${node.name} in ${this.wf.name}`);
    this.wf.nodes.push({ id: node.id ?? stableUuid(`${this.wf.id}:${node.name}`), ...node } as N8nNode);
    return node.name;
  }

  connect(from: string, to: string, fromOutput = 0, toInput = 0): this {
    const c = (this.wf.connections[from] ??= { main: [] });
    while (c.main.length <= fromOutput) c.main.push([]);
    c.main[fromOutput].push({ node: to, type: 'main', index: toInput });
    return this;
  }

  chain(...names: string[]): this {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
    return this;
  }

  sticky(name: string, content: string, pos: [number, number], size: [number, number] = [420, 220], color = 7): string {
    return this.add({ name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos, parameters: { content, width: size[0], height: size[1], color } });
  }

  // ------------------------------------------------------------ node kinds
  webhook(name: string, pathName: string, pos: [number, number], opts: { method?: string; respond?: 'onReceived' | 'lastNode' } = {}): string {
    return this.add({
      name,
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: pos,
      webhookId: stableUuid(`webhook:${pathName}`),
      parameters: {
        httpMethod: opts.method ?? 'POST',
        path: pathName,
        authentication: 'headerAuth',
        responseMode: opts.respond ?? 'onReceived',
        options: {},
      },
      credentials: { httpHeaderAuth: CREDENTIALS.webhook },
    });
  }

  subTrigger(name: string, pos: [number, number]): string {
    return this.add({ name, type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: pos, parameters: { inputSource: 'passthrough' } });
  }

  schedule(name: string, minutes: number, pos: [number, number]): string {
    return this.add({ name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos, parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } } });
  }

  /** HTTP call to the ApexWeb core API. `pathExpr` is a JS expression producing the path. */
  core(name: string, pathExpr: string, pos: [number, number], opts: { body?: string; method?: string; timeoutMs?: number; errorOutput?: boolean; notes?: string } = {}): string {
    const params: Record<string, unknown> = {
      method: opts.method ?? 'POST',
      url: `={{ '${this.#coreUrl}' + ${pathExpr} }}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-N8N-Execution-Id', value: '={{ $execution.id }}' },
          { name: 'X-N8N-Workflow', value: '={{ encodeURIComponent($workflow.name) }}' },
        ],
      },
      options: { timeout: opts.timeoutMs ?? 120_000 },
    };
    if ((opts.method ?? 'POST') !== 'GET') {
      params.sendBody = true;
      params.specifyBody = 'json';
      params.jsonBody = opts.body ?? '={{ JSON.stringify({}) }}';
    }
    return this.add({
      name,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: pos,
      parameters: params,
      credentials: { httpHeaderAuth: CREDENTIALS.coreApi },
      onError: opts.errorOutput ? 'continueErrorOutput' : 'stopWorkflow',
      notes: opts.notes,
      notesInFlow: !!opts.notes,
    });
  }

  execute(name: string, workflowId: string, workflowName: string, pos: [number, number], opts: { wait: boolean; each?: boolean }): string {
    return this.add({
      name,
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.2,
      position: pos,
      parameters: {
        source: 'database',
        workflowId: { __rl: true, value: workflowId, mode: 'list', cachedResultName: workflowName },
        workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
        mode: opts.each ? 'each' : 'once',
        options: { waitForSubWorkflow: opts.wait },
      },
    });
  }

  ifNode(name: string, leftExpr: string, pos: [number, number], op: { type: 'boolean' | 'number' | 'string'; operation: string; right?: unknown } = { type: 'boolean', operation: 'true' }): string {
    const single = op.right === undefined;
    return this.add({
      name,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: pos,
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{
            id: stableUuid(`${this.wf.id}:${name}:cond`),
            leftValue: `={{ ${leftExpr} }}`,
            rightValue: single ? '' : op.right,
            operator: { type: op.type, operation: op.operation, ...(single ? { singleValue: true } : {}) },
          }],
          combinator: 'and',
        },
        looseTypeValidation: true,
        options: {},
      },
    });
  }

  switchNode(name: string, valueExpr: string, cases: Array<{ value: string; label: string }>, pos: [number, number], fallback = true): string {
    return this.add({
      name,
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      position: pos,
      parameters: {
        rules: {
          values: cases.map((c) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
              conditions: [{ id: stableUuid(`${this.wf.id}:${name}:${c.value}`), leftValue: `={{ ${valueExpr} }}`, rightValue: c.value, operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: c.label,
          })),
        },
        looseTypeValidation: true,
        options: fallback ? { fallbackOutput: 'extra', renameFallbackOutput: 'Other' } : {},
      },
    });
  }

  code(name: string, js: string, pos: [number, number]): string {
    return this.add({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: js } });
  }

  setJson(name: string, jsonExpr: string, pos: [number, number]): string {
    return this.add({ name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos, parameters: { mode: 'raw', jsonOutput: `={{ JSON.stringify(${jsonExpr}) }}`, options: {} } });
  }

  splitOut(name: string, field: string, pos: [number, number]): string {
    return this.add({ name, type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: pos, parameters: { fieldToSplitOut: field, options: {} } });
  }

  wait(name: string, secondsExpr: string, pos: [number, number]): string {
    return this.add({ name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: pos, webhookId: stableUuid(`${this.wf.id}:${name}:wait`), parameters: { amount: `={{ ${secondsExpr} }}`, unit: 'seconds' } });
  }

  noop(name: string, pos: [number, number], notes?: string): string {
    return this.add({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: pos, parameters: {}, notes, notesInFlow: !!notes });
  }
}
