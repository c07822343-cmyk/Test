# Tool extensions

Drop an ES module (`.ts`, `.mjs` or `.js`) here to add a tool without touching the runner.
It is registered into the tool catalog at boot and becomes usable by any agent or skill
that lists it — **subject to the agent's tool permission profile**.

```js
// tools/phone-link-check.mjs
export default {
  name: 'phone_link_check',          // snake_case, unique
  permission: 'site_audit',          // must be an existing permission (see src/tools/catalog.ts)
  description: 'Flags phone numbers that are not wrapped in a tel: link.',
  timeoutMs: 30000,                  // optional, default 60s
  run({ site, task, facts }) {       // read-only inputs; no database, keys or config
    const findings = [];
    for (const [page, html] of Object.entries(site)) {
      if (/\(\d{3}\) \d{3}-\d{4}/.test(html) && !html.includes('href="tel:')) {
        findings.push({ severity: 'major', rule: 'phone_not_linked', page, detail: 'phone number without a tel: link' });
      }
    }
    return { summary: { pages: Object.keys(site).length }, findings, hard_failures: [] };
  },
};
```

Rules enforced at load time:

- The tool must declare one of the existing permissions. It cannot invent a new one, so it
  can never run for an agent whose profile does not already grant that permission.
- Inputs are frozen copies: the project's site files, the task's mission, and confirmed facts.
- Findings are normalised to `{ severity, rule, page, detail }` and capped.

Extension code runs in-process with the core's privileges. Install only code you have reviewed.
To use the tool, reference it from a skill (`"tools": ["phone_link_check"]`) or an agent extension.
