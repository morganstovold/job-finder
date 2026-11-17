# EMT Job Watch

A Cloudflare Worker that checks EMT job boards every minute and alerts you the moment a new
**EMT-B** posting near Benicia shows up. It sends an email, plus an optional free push notification.

## What it watches

911 employers and fire agencies only. IFT-focused companies (Royal, Falcon, ProTransport-1, Bay Medic,
NorCal, LIFEwest, AlphaOne, West Coast Medical) are deliberately left out.

| Board                           | Covers                                                                                       | How                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `careers.gmr.net` (iCIMS)       | AMR, CrowdRx, other GMR brands                                                               | JSON API, filtered by coordinates (60 mi)                  |
| `falcknc.employ.onshift.com`    | Falck Northern California (Alameda 911)                                                      | OnShift JSON API                                           |
| governmentjobs.com search       | Any fire district or city within 75 mi                                                       | site-wide search                                           |
| governmentjobs.com agency pages | Sac City Fire, Sac Metro Fire, Cosumnes, ConFire, San Ramon Valley, Moraga-Orinda, Palo Alto | each agency's own board, newest first (faster than search) |
| SmartRecruiters                 | City of SF, including SFFD H-3 EMT/Paramedic                                                 | public JSON API                                            |
| CalOpps                         | Small agencies (Benicia, Pacifica, San Bruno…)                                               | search page, filtered by place names                       |
| FCTC "Now Hiring"               | Fire departments recruiting off FCTC's Statewide Eligibility List                            | public page                                                |
| Medic Ambulance                 | Solano 911 (plus Sonoma, Sacramento)                                                         | its "Open Positions" list; alerts when a role appears      |

Not covered: **King-American** (SF 911). Its Paycom job board only serves listings to a browser
session, so subscribe with the **Create Job Alerts** button on
[its board](https://phx.us-west.paycomonline.net/v4/ats/web.php/portal/AD91210A1A43DAB866B5F4021AC8657E/career-page).

Only titles that look like EMT-B jobs count. That excludes paramedic-only jobs, AEMT, instructor and
faculty roles, interns, IFT/interfacility postings, and Firefighter/EMT unless the title says
single-role or non-safety. Tune
this in [`src/config.ts`](src/config.ts) and check it with `bun test`.

Postings can close fast (Sac City Fire's single-role EMT closed 14 minutes after opening at 250
applicants; AMR in about 45), so AMR/GMR, GovernmentJobs, the fire agency pages and SF are checked every minute. Falck
and CalOpps rate-limit, so they get every 5 minutes (as do FCTC and Medic) (`everyMinutes` in `src/config.ts`). A board
that fails backs off from its own pace (1, 2, 4… min; 5, 10, 20… for 5-minute boards, max 60) and
returns to normal after one success. D1 is only written when something changes, about 2,200 rows a
day against the free tier's 100k.

Each job alerts **once**, the first time it's seen (tracked in D1). The first run after deploying
emails everything currently open. If a board fails for 6+ hours (usually because the site changed),
you get one "scraper broken" alert.

## Setup

1. **Email.** In the Cloudflare dashboard, open stovold.dev → Email → Email Routing, make sure it's
   enabled, and add the inbox you want alerts in under **Destination addresses**. Click the
   verification link Cloudflare emails you. Sending is free.
2. **Push (optional, the "SMS").** Install [Pushover](https://pushover.net) (iOS/Android, $5 one-time
   after a 30-day trial) and log in. Copy your **user key** from the Pushover dashboard, then create an
   application ("Create an Application/API Token") and copy its **API token**. Each alert links to the
   job's apply page, with a Dashboard link in the message. Alerts use priority 1 (sounds even during
   quiet hours); set `PUSH_PRIORITY = 2` in `src/notify.ts` to make them repeat until acknowledged.
3. Copy `.env.example` to `.env` and fill in `NOTIFY_EMAIL`, `PUSHOVER_USER`, `PUSHOVER_TOKEN`, and `ADMIN_KEY`.
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
10DLC or toll-free verification (forms and a few days' wait) before texts deliver reliably. A
Pushover push arrives just as fast for a one-time $5. (ntfy was tried first, but ntfy.sh times out
on requests from Cloudflare Workers.) If you still want real SMS later, it's one more
function in `src/notify.ts`.
