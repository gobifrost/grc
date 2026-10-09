# Bifrost GRC app

This is the Solution-owned administration app. Start connected local development
from the Solution root with:

```bash
bifrost solution start
```

For frontend-only work, run `npm run dev` in this directory after selecting a
Bifrost CLI connection. The deployed Bifrost host passes each viewer's bootstrap
to `mount()`; the production bundle contains no API URL or access token.

The Bifrost platform injects the web SDK when it builds a Solution. Do not add an
instance SDK URL to this package.
