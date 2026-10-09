# Bifrost GRC

Bifrost GRC is a portable Bifrost Solution for managing policies, controls,
assessments, risks, evidence, questionnaires, and customer-scoped facts. It
includes the **Bifrost GRC** administration app and the **Policies** employee
sign-off app.

## Install

Install from a repository with the Bifrost CLI:

```bash
bifrost solution install-repo https://github.com/gobifrost/grc
```

The CLI installs into the caller's organization. This Solution is intended for
Service Managers who administer several managed organizations: after installation,
open the Solution's **Organization** setting in Bifrost and select **Global**.
Then assign the GRC roles to the appropriate provider and customer users. The
Policies app is for customer-organization **GRC Viewers**; the administration app
uses **GRC Auditor**, **GRC Contributor**, and **GRC Administrator** roles.

Repository installs are Git-connected. Use the platform's Solution Git lifecycle
to review and apply updates; merging to this repository does not update an
installed Solution by itself.

See [setup](docs/setup.md) for role, AI, integration, and optional delegation
requirements.

## Local validation

```bash
docker run --rm --entrypoint sh \
  -v "$PWD":/solution:ro \
  -v "${BIFROST_API_DIR:?set this to your Bifrost api directory}":/sdk:ro \
  -w /solution \
  -e PYTHONPATH=/sdk:/solution \
  "${BIFROST_TEST_IMAGE:?set this to your Bifrost test image}" \
  -lc 'pytest -q tests/test_grc_portability.py'

(cd apps/bifrost-grc-v2 && npm ci && npm run typecheck && npm run build)
(cd apps/policies && npm ci && npm run typecheck && npm run build)
```

The Docker command mounts the actual Bifrost SDK source; set its two variables
from a Bifrost checkout and its matching test image. The platform injects the
web SDK for Solution builds, so app package files intentionally do not pin an
instance SDK URL. For connected local work, start the installed Solution with
`bifrost solution start`; its selected connection supplies the local API URL
and credentials.
