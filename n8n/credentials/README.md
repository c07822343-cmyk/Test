# n8n credentials

No credential files are stored here (`*.json` in this folder is git-ignored).

`npm run n8n:bootstrap` (or the `n8n-init` service in `docker-compose.yml`) creates two
**Header Auth** credentials directly in n8n's encrypted credential store:

| Credential id      | Name                         | Header                         | Value from            |
|--------------------|------------------------------|--------------------------------|-----------------------|
| `apxCredCoreApi01` | ApexWeb Core API             | `Authorization: Bearer …`      | `APEXWEB_API_TOKEN`   |
| `apxCredWebhook01` | ApexWeb Webhook Secret       | `X-ApexWeb-Webhook-Secret: …`  | `N8N_WEBHOOK_SECRET`  |

The values are written to a 0600 temporary file only for the duration of the import and
deleted immediately. Workflow JSON references credentials by id only, so no secret ever
appears in node parameters or execution logs.

**NVIDIA keys are never given to n8n.** n8n asks the core for a lease; the core holds the
keys, makes the NVIDIA call and returns only the result and a masked key id.

To rotate: change the value in `.env`, re-run the bootstrap (it overwrites both credentials
by id), then restart the core and n8n.
