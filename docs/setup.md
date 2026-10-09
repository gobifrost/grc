# Bifrost GRC setup

## Roles and provider context

Assign the Solution roles deliberately:

- **GRC Viewer** reviews and signs assigned policies in the Policies app.
- **GRC Auditor** has read-only access to the administration app and the
  Investigation Agent.
- **GRC Contributor** can make governed GRC changes through the administration
  app and Steward.
- **GRC Administrator** administers the Solution's GRC work.

The bundled table and file policies intentionally preserve the provider-context
boundary. Provider-organization GRC roles may directly administer managed files
and may work across managed organizations. Customer-organization users remain
restricted to their own rows through the same policies and workflow checks.
Do not weaken these policies merely to make a new installation appear broader.

## AI and integrations

The bundled agents do not select an AI model profile. Configure model access in
the target Bifrost environment for the intended users.

Questionnaire extraction, drafting, audience classification, and recommendation
classification require an enabled **OpenRouter** integration in the target
environment. Its setup shell requires an `api_key` and `default_model`. The optional `GRC_QUESTIONNAIRE_MODEL` and
`GRC_RECOMMENDATION_MODEL` configuration keys select models; otherwise the
integration default is used. These integration credentials and configuration
values are environment data and are not part of this Solution.

The optional CISO Assistant import uses an environment-configured **CISO
Assistant** integration. Its shell requires `base_url` and accepts either a
personal access token or username and password. Configure it only when that
migration path is required.

## Agent dependencies

The bundled GRC Steward delegates only to the bundled GRC Investigation Agent.
Its tool references identify bundled workflows. Solution installation remaps
those references to the fresh install's workflow records, so the agent graph
stays within this package.

A provider may intentionally augment Steward with separately managed process,
security-questionnaire, endpoint, or identity agents after installation. Those
agents and their integration access are provider-specific, so their instance
identifiers are not distributed in this manifest. Create a private Solution
overlay (for example, in a private fork), add its agent references to
`.bifrost/agents.yaml`, and apply it through the supported Solution deployment
or Git update lifecycle. Preserve each provider agent's authorized roles and
organization scope, and review its external permissions before deployment. Do
not edit Solution-managed installed agents through the platform's agent
management API.

## Local development

Run `bifrost solution start` from the Solution root. For a frontend-only preview,
run `npm run dev` in either app directory after selecting a Bifrost CLI
connection. The Vite configuration reads selectors only for `serve`; production
builds never read the CLI credential store or bake a token into the bundle.
