// ApexWeb commands for the Main Agent chat. Commands are a convenience layer:
// natural-language requests work too. Every command maps to a real operation.
import { getAgent } from '../agents/registry.ts';
import type { Services } from '../services.ts';
import { cancelTask, retryTask } from '../api/overrides.ts';
import { usageReport } from '../api/usage.ts';
import type { ProjectRow } from '../queue/types.ts';
import { activityFeed } from '../api/activity.ts';
import { computeScorecard } from '../quality/scorecard.ts';
import { AppError } from '../util/common.ts';
import { MODES, type Mode } from './approvals.ts';
import type { ReceiveResult } from './mainAgent.ts';
import { templateFor, type PlanTask } from './templates.ts';

export const COMMANDS: Array<{ cmd: string; usage: string; description: string }> = [
  { cmd: '/help', usage: '/help', description: 'List commands.' },
  { cmd: '/newproject', usage: '/newproject <request>', description: 'Start a new project from a request.' },
  { cmd: '/build', usage: '/build <what to build>', description: 'Start a website build project.' },
  { cmd: '/audit', usage: '/audit <url>', description: 'Audit an existing website (no changes made).' },
  { cmd: '/research', usage: '/research <topic>', description: 'Source-aware research brief.' },
  { cmd: '/status', usage: '/status', description: 'Status of the current project (or all projects).' },
  { cmd: '/tasks', usage: '/tasks', description: 'List the current project\'s tasks with state.' },
  { cmd: '/activity', usage: '/activity', description: 'Recent agent activity for the current project.' },
  { cmd: '/pause', usage: '/pause', description: 'Pause the current project.' },
  { cmd: '/resume', usage: '/resume', description: 'Resume the current project.' },
  { cmd: '/cancel', usage: '/cancel [task_id]', description: 'Cancel the project, or one task.' },
  { cmd: '/retry', usage: '/retry <task_id>', description: 'Retry a failed/blocked task and continue from it.' },
  { cmd: '/review', usage: '/review', description: 'Second set of eyes: independent reviews + triage + visual QA on the current site.' },
  { cmd: '/test', usage: '/test', description: 'Testing pass: bugs, responsive, accessibility, performance.' },
  { cmd: '/qa', usage: '/qa', description: 'Visual QA loop + final QA on the current site.' },
  { cmd: '/fix', usage: '/fix <problem>', description: 'Critical-priority bug fix with change review and regression check.' },
  { cmd: '/handoff', usage: '/handoff', description: 'Approve the handoff / final output of the current project.' },
  { cmd: '/approve', usage: '/approve [approval_id] [note]', description: 'Approve a pending gate (plan, redesign, handoff, rollback).' },
  { cmd: '/reject', usage: '/reject <approval_id> [reason]', description: 'Reject a pending gate.' },
  { cmd: '/mode', usage: '/mode <assist|semi|autopilot>', description: 'Switch the operating mode of the current project.' },
  { cmd: '/dryrun', usage: '/dryrun <request>', description: 'Plan a project and show the dry run; execute only after approval.' },
  { cmd: '/skills', usage: '/skills [name]', description: 'List skills, or show one skill and its versions.' },
  { cmd: '/scorecard', usage: '/scorecard', description: 'Compute the quality scorecard for the current site.' },
  { cmd: '/usage', usage: '/usage', description: 'NVIDIA usage and avoided work for the current project.' },
  { cmd: '/snapshots', usage: '/snapshots', description: 'List version-control snapshots of the project.' },
  { cmd: '/rollback', usage: '/rollback <snapshot_id>', description: 'Request a rollback (approval required; applied as a new commit).' },
  { cmd: '/knowledge', usage: '/knowledge [candidates]', description: 'List knowledge base entries or pending candidates.' },
  { cmd: '/promote', usage: '/promote <knowledge_id>', description: 'Promote a candidate lesson into active global knowledge.' },
];

const pick = (tpl: string, keys: string[], extra: Partial<PlanTask> = {}): PlanTask[] =>
  templateFor(tpl).tasks.filter((t) => keys.includes(t.key)).map((t) => ({ ...t, ...extra, depends_on: t.depends_on.filter((d) => keys.includes(d)) }));

export function attachCommands(s: Services): void {
  s.mainAgent.commandHandler = async ({ message, project, actor }) => handleCommand(s, message, project, actor);
}

async function currentProject(s: Services, project: ProjectRow | null): Promise<ProjectRow> {
  if (project) return project;
  const [latest] = await s.projects.list(1);
  if (!latest) throw new AppError('no_project', 'There is no project yet. Start one with /newproject <request>.');
  return latest;
}

async function hasSite(s: Services, projectId: string): Promise<boolean> {
  return Object.keys(await s.artifacts.latestText(projectId, 'site/')).some((f) => f.endsWith('.html'));
}

export async function handleCommand(s: Services, message: string, project: ProjectRow | null, actor: string): Promise<ReceiveResult | null> {
  const [cmd, ...rest] = message.trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  const reply = (text: string, p: ProjectRow | null = project, data?: unknown): ReceiveResult => ({ type: 'command', project: p, reply: text, data });
  switch (cmd.toLowerCase()) {
    case '/help':
      return reply(COMMANDS.map((c) => `${c.usage} — ${c.description}`).join('\n') + '\nNatural-language requests work too.');
    case '/newproject':
      if (!arg) return reply('Usage: /newproject <request>');
      return s.mainAgent.startProject(arg, null, actor);
    case '/build':
      if (!arg) return reply('Usage: /build <what to build>');
      return s.mainAgent.startProject(`Build: ${arg}`, null, actor);
    case '/audit':
      if (!/^https?:\/\//.test(arg)) return reply('Usage: /audit <https://site-to-audit>');
      return s.mainAgent.startProject(`Audit the website ${arg}`, null, actor, { intentHint: 'website_audit' });
    case '/research':
      if (!arg) return reply('Usage: /research <topic>');
      return s.mainAgent.startProject(`Research: ${arg}`, null, actor, { intentHint: 'research_only' });
    case '/dryrun':
      if (!arg) return reply('Usage: /dryrun <request>');
      return s.mainAgent.startProject(arg, null, actor, { dryRun: true });
    case '/status': {
      const text = await s.mainAgent.statusReport(project?.id ?? null);
      return reply(text);
    }
    case '/tasks': {
      const p = await currentProject(s, project);
      const tasks = (await s.queue.listByProject(p.id)).filter((t) => t.kind !== 'root');
      return reply(tasks.map((t) => `${t.status.padEnd(9)} ${t.stage ?? ''} · ${getAgent(t.agent_type).name}: ${t.title} [${t.id}]${t.revision ? ` rev ${t.revision}` : ''}`).join('\n') || 'No tasks.', p);
    }
    case '/activity': {
      const p = await currentProject(s, project);
      const { items } = await activityFeed(s.db, { projectId: p.id, limit: 400 });
      return reply(items.slice(-25).map((i) => `${i.agent.toUpperCase()}\n  ${i.headline}`).join('\n') || 'No activity yet.', p);
    }
    case '/pause':
    case '/resume': {
      const p = await currentProject(s, project);
      await s.mainAgent.control(p.id, cmd === '/pause' ? 'pause' : 'resume', actor);
      return reply(`Project ${p.name} ${cmd === '/pause' ? 'paused' : 'resumed'}.`, p);
    }
    case '/cancel': {
      if (arg.startsWith('tsk_')) {
        const t = await cancelTask(s, arg, actor);
        return reply(`Cancelled task ${t.title}.`);
      }
      const p = await currentProject(s, project);
      await s.mainAgent.control(p.id, 'cancel', actor);
      return reply(`Project ${p.name} cancelled.`, p);
    }
    case '/retry': {
      if (!arg.startsWith('tsk_')) return reply('Usage: /retry <task_id>');
      const t = await retryTask(s, arg, actor);
      return reply(`Retrying ${t.title}; dependent work will continue when it completes.`);
    }
    case '/review':
    case '/test':
    case '/qa': {
      const p = await currentProject(s, project);
      if (!(await hasSite(s, p.id))) return reply('This project has no site files to check yet.', p);
      const tasks = cmd === '/review'
        ? pick('prelaunch_qa', ['bug_hunt', 'responsive', 'accessibility', 'performance', 'seo_audit', 'triage', 'visual_qa']).concat([{ key: 'ux_review', agent_type: 'ux_reviewer', title: 'Independent UX review', mission: 'Walk the primary journeys in the blueprint and report friction with element-level fixes.', depends_on: [], priority: 62 }, { key: 'design_review', agent_type: 'design_critic', title: 'Independent design critique', mission: 'Strict visual review against the design system and anti-slop rules.', depends_on: [], priority: 62 }]).map((t) => (t.key === 'triage' ? { ...t, depends_on: [...t.depends_on, 'ux_review', 'design_review'] } : t))
        : cmd === '/test'
          ? pick('prelaunch_qa', ['bug_hunt', 'responsive', 'accessibility', 'performance'])
          : pick('prelaunch_qa', ['visual_qa', 'final_qa']);
      await s.mainAgent.extendProject(p.id, tasks, cmd.slice(1), actor);
      return reply(`${cmd === '/review' ? 'Second set of eyes' : cmd === '/test' ? 'Testing pass' : 'QA loop'} started on ${p.name}: ${tasks.map((t) => getAgent(t.agent_type).name).join(', ')}.`, p);
    }
    case '/fix': {
      if (!arg) return reply('Usage: /fix <what is broken>');
      const p = project ?? (await s.projects.list(1))[0] ?? null;
      if (p && (await hasSite(s, p.id))) {
        const tasks = templateFor('emergency_bug_fix').tasks.map((t) => (t.key === 'reproduce' ? { ...t, mission: `${t.mission} Reported problem: "${arg.slice(0, 2000)}"` } : t));
        await s.mainAgent.extendProject(p.id, tasks, 'fix', actor);
        return reply(`Emergency fix started on ${p.name} at CRITICAL priority: reproduce → fix → change review → regression check.`, p);
      }
      return s.mainAgent.startProject(`Emergency bug fix: ${arg}`, null, actor, { intentHint: 'emergency_bug_fix' });
    }
    case '/handoff': {
      const p = await currentProject(s, project);
      const pending = (await s.approvals.list({ projectId: p.id, status: 'pending' })).find((a) => a.gate === 'final_handoff');
      if (pending) return reply(await s.mainAgent.resolveApproval(pending.id, 'approved', actor), p);
      if (p.status === 'COMPLETED') {
        await s.mainAgent.approve(p.id, actor);
        return reply(`Handoff approved for ${p.name}. The package is final.`, p);
      }
      return reply(`${p.name} is ${p.status} (stage ${p.stage}); the handoff becomes available once assembly completes.`, p);
    }
    case '/approve':
    case '/reject': {
      const [id, ...note] = rest;
      let approvalId = id;
      if (!approvalId && cmd === '/approve') {
        const p = await currentProject(s, project);
        approvalId = (await s.approvals.list({ projectId: p.id, status: 'pending' }))[0]?.id;
      }
      if (!approvalId) return reply('No pending approval found. Usage: /approve <approval_id>');
      return reply(await s.mainAgent.resolveApproval(approvalId, cmd === '/approve' ? 'approved' : 'rejected', actor, note.join(' ') || null));
    }
    case '/mode': {
      const p = await currentProject(s, project);
      if (!MODES.includes(arg as Mode)) return reply(`Current mode: ${p.mode}. Usage: /mode assist|semi|autopilot`, p);
      const updated = await s.mainAgent.setMode(p.id, arg as Mode, actor);
      return reply(`${p.name} is now in ${updated.mode} mode.`, updated);
    }
    case '/skills': {
      if (arg) {
        const d = s.skills.resolve(arg);
        if (!d) return reply(`Unknown skill ${arg}.`);
        const versions = s.skills.catalog().find((c) => c.name === d.name)?.versions ?? [];
        return reply(`${d.title} (${d.name}@${d.version}) — ${d.description}\nWhen: ${d.when_to_use}\nAgents: ${d.compatible_agents.join(', ')}\nTools: ${d.tools.join(', ') || 'none'}\nSub-skills: ${d.sub_skills.join(', ') || 'none'}\nVersions: ${versions.map((v) => `${v.version}${v.enabled ? '' : ' (disabled)'}`).join(', ')}`);
      }
      return reply(s.skills.catalog().map((c) => `${c.name}@${c.latest} — ${c.title} [${c.category}]`).join('\n'));
    }
    case '/scorecard': {
      const p = await currentProject(s, project);
      const card = await computeScorecard(s.db, s.artifacts, p.id, (await s.memory.get<string[]>('project', p.id, 'facts')) ?? []);
      await s.db.query('UPDATE projects SET scorecard = $2 WHERE id = $1', [p.id, JSON.stringify(card)]);
      return reply([`Scorecard: ${card.totals.passed} passed, ${card.totals.failed} failed, ${card.totals.not_evaluated} not evaluated.`, ...card.criteria.map((c) => `${c.passed === null ? '—' : c.passed ? 'PASS' : 'FAIL'} ${c.id} [${c.category}] ${c.criterion}: ${c.evidence}`)].join('\n'), p, card);
    }
    case '/usage': {
      const u = await usageReport(s.db, project?.id ?? null);
      return reply(`NVIDIA: ${u.nvidia.requests} requests (${u.nvidia.failed} failed), ${u.nvidia.prompt_tokens + u.nvidia.completion_tokens} tokens. Avoided: ${u.avoided.model_calls_saved_by_cache} model call(s) via cache, ${u.avoided.web_fetches_saved_by_cache} web fetch(es), ${u.avoided.duplicate_tasks_prevented} duplicate task(s). Retries ${u.work.retries}, revisions ${u.work.revisions}, fix cycles ${u.work.fix_cycles}.`, project, u);
    }
    case '/snapshots': {
      const p = await currentProject(s, project);
      const snaps = await s.repos.list(p.id);
      return reply(snaps.map((x) => `${x.id} ${x.stable ? '[stable] ' : ''}${x.commit_sha?.slice(0, 8) ?? '--------'} ${x.label}`).join('\n') || 'No snapshots yet.', p);
    }
    case '/rollback': {
      const p = await currentProject(s, project);
      if (!arg) return reply('Usage: /rollback <snapshot_id> (see /snapshots)', p);
      const id = await s.mainAgent.requestRollback(p.id, arg, actor);
      return reply(`Rollback requested; approve with /approve ${id}.`, p);
    }
    case '/knowledge': {
      const entries = await s.knowledge.list(arg === 'candidates' ? 'candidate' : 'active');
      return reply(entries.map((k) => `${k.id} [${k.category}] ${k.title}${k.status === 'candidate' ? ` (candidate from ${k.source_project})` : ''}`).join('\n') || 'Nothing here yet.');
    }
    case '/promote': {
      if (!arg) return reply('Usage: /promote <knowledge_id>');
      const k = await s.knowledge.decide(arg, 'promote', actor);
      return reply(`Promoted "${k.title}" into active ApexWeb knowledge.`);
    }
    default:
      return reply(`Unknown command ${cmd}. Try /help.`);
  }
}
