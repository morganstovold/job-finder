# EMT Job Watch

A Cloudflare Worker that checks EMT job boards every 10 minutes and alerts you the moment a new
**EMT-B** posting near Benicia shows up. It sends an email, plus an optional free push notification.

## What it watches

| Board                        | Covers                                                                  | How                                       |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `careers.gmr.net` (iCIMS)    | AMR, CrowdRx, other GMR brands                                          | JSON API, filtered by coordinates (60 mi) |
| `falcknc.employ.onshift.com` | Falck Northern California (Alameda 911)                                 | OnShift JSON API                          |
| governmentjobs.com (NEOGOV)  | Most fire districts and cities (ConFire, SRVFPD, Sac Metro, Solano Co…) | search results within 75 mi               |
| SmartRecruiters              | City of SF, including SFFD H-3 EMT/Paramedic                            | public JSON API                           |
| CalOpps                      | Small agencies (Benicia, Moraga-Orinda, Pacifica, San Bruno…)           | search page, filtered by place names      |

Only titles that look like EMT-B jobs count. That excludes paramedic-only jobs, AEMT, instructor and
faculty roles, interns, and Firefighter/EMT unless the title says single-role or non-safety. Tune
this in [`src/config.ts`](src/config.ts) and check it with `bun test`.

Each job alerts **once**, the first time it's seen (tracked in D1). The first run after deploying
emails everything currently open. If a board fails for 6+ hours (usually because the site changed),
you get one "scraper broken" alert.

## Setup

1. **Email.** In the Cloudflare dashboard, open stovold.dev → Email → Email Routing, make sure it's
   enabled, and add the inbox you want alerts in under **Destination addresses**. Click the
   verification link Cloudflare emails you. Sending is free.
2. **Push (optional, the "SMS").** Install the [ntfy](https://ntfy.sh) app (iOS/Android) and
   subscribe to a long random topic name, e.g. `morgan-emt-` followed by `openssl rand -hex 8`.
   It's free, instant, and each alert opens the apply page when tapped.
   Optionally create an access token (ntfy.sh → Account → Access tokens) and set `NTFY_TOKEN`.
   Without one, ntfy rate-limits by IP, and Cloudflare Workers share IPs with everyone else's Workers.
3. Copy `.env.example` to `.env` and fill in `NOTIFY_EMAIL`, `NTFY_TOPIC`, `NTFY_TOKEN`, and `ADMIN_KEY`.
4. Deploy:

   ```bash
   bun run deploy
   ```

5. Test: visit `https://jobs.stovold.dev/test?key=<ADMIN_KEY>` to send a test alert, or
   `/run?key=<ADMIN_KEY>` to run a check now. `/` is a small dashboard of recent matches and
   board health.

## Commands

```bash
bun run scan        # hit every board from your laptop and print matches (no deploy needed)
bun run scan --all  # …including non-matches, to see what the filter is dropping
bun run check       # typecheck + oxlint + oxfmt --check + tests
bun run check:fix   # same, but auto-fix lint and formatting
bun run dev         # local worker on :1337 (emails land in .alchemy/local/email)
```

## Adding a company

Add an entry to `SOURCES` in `src/config.ts`:

- Another Falck region: `{ kind: "onshift", name: "Falck X", tenant: "<slug>" }`. The slug is the
  subdomain in its apply links.
- A specific agency's NEOGOV page is already covered by the governmentjobs.com search.
- A board on a new system needs a fetcher in `src/sources.ts`, which returns `Job[]`.

## Why not SMS?

Twilio costs about $1.15/mo for a number plus ~$0.01 per text, and US carriers now require A2P
10DLC or toll-free verification (forms and a few days' wait) before texts deliver reliably. ntfy
push arrives just as fast and costs nothing. If you still want real SMS later, it's one more
function in `src/notify.ts`.
