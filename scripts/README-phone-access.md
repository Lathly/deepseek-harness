# DSH Web — phone access over Tailscale

Phone entry that survives DSH restarts: one bookmark, no typing, ever.

## The path

```
phone bookmark:  http://pop-os.taildc49b0.ts.net:3090/dsh
        │
        ▼
trampoline (:3090)              scripts/dsh-web-redirect.py
  reads fresh token per request from ~/.dsh/web-launch-token
  answers / and /dsh with 302 → https://pop-os.taildc49b0.ts.net/?token=<fresh>
        │
        ▼
tailscale serve (:443)          https → http://localhost:3080
        │
        ▼
DSH Web (:3080, loopback)       validates token, sets cookie dsh-auth-<sha256>,
                                303 → /  (webui, then live WS /api/remote.mux)
```

DSH itself binds loopback only; the tailnet reaches it solely through `tailscale serve`.
The trampoline exists because the launch token changes on every DSH start — the bookmark
never needs editing, the trampoline always reads the current one.

## Components

| What | Where | Notes |
| --- | --- | --- |
| Trampoline service | `scripts/dsh-web-redirect.py`, systemd user unit `dsh-web-redirect.service` | port 3090, Restart=on-failure; `/dsh-url` returns plain text, `/health` JSON |
| URL refresher | `scripts/dsh-web-url.sh`, `dsh-web-url.{service,timer}` | refreshes `~/.dsh/web-auth-url.txt` every 60 s (bookmark line + loopback token URL); this file is what Aria or a human fetches for the current URL |
| Launch token | `~/.dsh/web-launch-token` | written by DSH Web on every start; consumed by the trampoline |
| Cookie secret | `~/.dsh/.credentials.yaml` → `client-connection/browser-session` | persistent HMAC signing secret; a cookie minted once stays valid ~30 days across restarts |
| Host fence entry | `packages/bundle/web-app/cordis.patch.yml` → `trustedHosts` | see below |
| Proxy | `tailscale serve --https=443 http://localhost:3080` | **must stay pointed at 3080**, never at the trampoline |

## Bookmark rule

Bookmark the **trampoline URL** (`http://pop-os.taildc49b0.ts.net:3090/dsh`), not the
direct `https://` URL. The trampoline performs a fresh token exchange on every hit, so
the entry works whether the cookie is fresh, expired, or never issued — including right
after a DSH restart.

## The Host/Origin fence

Every `/api` request and the gateway WebSocket are guarded by the browser-trust fence
(`packages/client/connection/src/api-request-trust.ts`): the `Host` header must be
loopback or listed in the connection plugin's `trustedHosts`. The serve proxy forwards
`Host: pop-os.taildc49b0.ts.net`, so without an entry every API call gets a 403 and the
webui renders as an empty shell (the index page itself is cookie-only, which is why the
skeleton still loads).

The entry lives in `cordis.patch.yml` as a **quoted** JS string:

```yaml
trustedHosts: !!js "['pop-os.taildc49b0.ts.net', ...ctx.webRuntime.trustedHosts]"
```

Unquoted, YAML parses the flow sequence as a list instead of JS source and the config
load fails — keep the quotes. Equivalent launch flag: `pnpm dsh web
--trusted-host pop-os.taildc49b0.ts.net` (repeatable, but CLI-only; the patch file is
what makes a bare `pnpm dsh web` correct).

## Troubleshooting

- **Page renders, no conversations** — fence rejection. Response bodies distinguish:
  `forbidden` (403) is the fence, `unauthorized` (401) is auth. Check the `trustedHosts`
  line, then restart DSH Web.
- **Bookmark unreachable** — `systemctl --user status dsh-web-redirect dsh-web-url.timer`.
- **WS test from CLI** — use `curl --http1.1` with Upgrade headers against
  `https://pop-os.taildc49b0.ts.net/api/remote.mux`; HTTP/2 refuses Upgrade headers and
  fails regardless of the fence. Expect 101 with a valid cookie.
- **Cookies are authority-bound** — cookies minted via the tailnet name only validate on
  tailnet-host requests; loopback cookies never fit and vice versa.
- **Boot survival** — user services need `sudo loginctl enable-linger lathly` (one time)
  or they start only at the next interactive login.

## Do not

- Point serve 443 at 3090 — the token exchange and page content would land on the
  trampoline: loop/404.
- Expect scripts here to restart DSH Web for you. Config is the durable artifact;
  booting the server is the operator's job.
