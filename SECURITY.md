# Security and publication

MoneySaver is a single-household application. Everyone authenticated to the web interface can read and change the same financial data and settings. It is not a multi-user hosting service.

## Publish source safely

1. Run `npm run security:hooks` in the working repository. The pre-commit hook inspects staged bytes. The pre-push hook checks reachable history and runs Gitleaks with redacted output; missing Gitleaks blocks the push.
2. Install Gitleaks from its [official releases](https://github.com/gitleaks/gitleaks/releases), verify its published checksum, and put it on PATH or set `GITLEAKS_BIN` to the executable's absolute path. The local `tmp/tools` installation is also recognized. Hooks are local and must be enabled in each clone.
3. Run `npm test`, then `npm run export:github`. This creates `output/github-ready` from an explicit source allowlist. Private documents, original task XML, attachments, data, logs, backups, debug output, and the original `.git` directory are excluded. Reviewed binary fixtures must match their approved hashes. The export refuses to overwrite an existing destination.
4. In the exported repository, run `npm run security:check`, `npm run security:secrets`, and review the file list before pushing. The initial commit uses a project identity with a noreply email. The original repository and history stay local; the history check intentionally blocks pushing them.
5. Create a **private** GitHub repository first. Enable account two-factor authentication, review collaborators, and enable secret scanning, push protection, and code scanning where available. GitHub settings require the account owner's authenticated session and are not changed by these scripts. The included workflow checks publication policy, dependencies, and secrets; Dependabot checks npm and workflow updates.
6. Review screenshots, issue text, CI output, and release attachments before posting. Scanners do not reliably recognize personal financial data. A clean scan is not proof of anonymity.

Exports additionally compare candidate text against known credentials/chat identifiers, nearby income name-and-amount pairs, and distinctive mortgage-history values from the local database opened read-only. This check never prints the matched values or changes the database. It is skipped when no local private database is available; `MONEYSAVER_PRIVATE_DB` can select a read-only comparison source. This catches known overlaps, not every possible personal detail. Test examples must be invented independently, including names, identifiers, dates, merchants, and amounts.

Never commit a real `.env`, credentials, database or SQLite sidecar, trained model containing private examples, backup, customer document, or source screenshot. `.gitignore` does not remove files from prior commits. Never merge the original private history into the publication copy. If a credential is exposed, revoke or rotate it first, then follow [GitHub's removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Web access

The server retains dual-stack `::` listening. A middleware gate runs before static files and API routes. By default it accepts only direct loopback connections with a localhost/IP Host header. Cross-origin browser requests, foreign Host headers, remote connections, and unsolicited forwarding headers are rejected. This does not protect against other software or OS users already running on the machine.

For password protection, copy `.env.example` to `.env` and set `MONEYSAVER_WEB_PASSWORD` to a random password of at least 32 characters. Generate one locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. The browser's Basic authentication username is `moneysaver`. Restart the service after changing configuration. Keep the real `.env` private. A local health request returns only service status without authentication so the watchdog can operate.

Remote access additionally requires all of the following:

- A local TLS reverse proxy, with an actual domain and certificate; `deploy/Caddyfile.example` supplies the proxy configuration. Caddy obtains and renews the certificate when DNS and ports are configured correctly.
- `MONEYSAVER_PUBLIC_ORIGIN=https://your-domain.example.com` and `MONEYSAVER_TRUST_LOCAL_PROXY=1`, plus the strong password.
- Firewall rules blocking inbound connections to Node port 3000 and ML port 8300. Only the HTTPS proxy should accept remote web connections. No firewall, DNS, certificate, or external hosting changes are made by installing this project.
- A proxy that overwrites Host and X-Forwarded-Proto rather than trusting client-supplied values. Forwarding is accepted only from a loopback connection, for the exact configured HTTPS origin. Shared passwords grant full household access. HTTP Basic credentials must never be sent over remote plain HTTP.

Failed login attempts are rate limited. Responses are marked no-store; HTTPS responses include HSTS. Browser Basic authentication can remain cached until the browser is closed. Do not use it on shared devices. Use an authenticated VPN or identity-aware gateway if individual user accounts or MFA are needed.

## Data at rest and external services

The SQLite database and backups include API credentials, financial history, and document blobs; the application does not encrypt them. Restrict filesystem access and enable OS drive encryption. Store off-device backups encrypted and periodically test recovery. Machine-wide encryption and filesystem policy must be configured by the device owner.

OCR debug snapshots are disabled by default. Setting `MONEYSAVER_OCR_DEBUG=1` writes raw transaction text into the private data directory for troubleshooting; disable it afterwards. Older snapshots already on disk remain private and are excluded from publication.

Optional AI features send financial context to the configured provider. Identifier removal reduces exposure but does not make financial data anonymous. Telegram bot messages and uploaded files pass through Telegram. Public market-rate requests, dependency installation, and the first OCR language download also use the network. Keep tokens out of logs, screenshots, examples, and CI secrets unless a specific workflow needs them. Tests use isolated local data and do not require production credentials.

Report vulnerabilities privately through GitHub private vulnerability reporting when enabled. Do not include real credentials or financial documents in a public issue.
