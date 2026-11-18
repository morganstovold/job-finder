# EMT Job Watch

A Cloudflare Worker that checks job boards every minute and alerts you the moment a new **EMT-B**
job or **firefighter trainee/recruit** opening near Benicia shows up. It sends an email, plus an
optional push notification.

## What it watches

911 employers and fire agencies only. IFT-focused companies (Royal, Falcon, ProTransport-1, Bay Medic,
NorCal, LIFEwest, AlphaOne, West Coast Medical) are deliberately left out.

| Board                           | Covers                                                                                               | How                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `careers.gmr.net` (iCIMS)       | AMR, CrowdRx, other GMR brands                                                                       | JSON API, filtered by coordinates (60 mi)             |
| `falcknc.employ.onshift.com`    | Falck Northern California (Alameda 911)                                                              | OnShift JSON API                                      |
| governmentjobs.com agency pages | Sac City Fire, Sac Metro Fire, San Ramon Valley, Moraga-Orinda, Palo Alto, Folsom, ConFire, Cosumnes | each agency's own board, newest first: the fast path  |
| governmentjobs.com search       | Any fire district or city within 75 mi (EMT + firefighter trainee/recruit keywords)                  | site-wide search: the wide net, every 5 min           |
| SmartRecruiters                 | City of SF: SFFD H-3 EMT/Paramedic and H-2 entry-level Firefighter                                   | public JSON API                                       |
| CalOpps                         | Small agencies (Benicia, Pacifica, San Bruno…)                                                       | EMT and firefighter searches, filtered by place names |
| FCTC "Now Hiring"               | Departments recruiting off FCTC's Statewide Eligibility List                                         | public page, every 5 min, priority 1                  |

Not covered: **King-American** (SF 911). Its Paycom job board only serves listings to a browser
session, so subscribe with the **Create Job Alerts** button on
[its board](https://phx.us-west.paycomonline.net/v4/ats/web.php/portal/AD91210A1A43DAB866B5F4021AC8657E/career-page).

Each title is sorted into one of two categories, or skipped (`classifyTitle` in `src/filter.ts`,
rules in [`src/config.ts`](src/config.ts), checked with `bun test`):

- **EMT** (EMT-B jobs): excludes paramedic-only jobs, AEMT, instructor and faculty roles, interns,
  event standby, and IFT/interfacility postings (unless the title also says 911). Firefighter titles
  only count here if they say single-role or non-safety.
- **FF Recruit** (entry-level firefighter where the department runs its own academy): Firefighter
  Trainee / Recruit, Fire Recruit, Recruit Firefighter, Probationary Firefighter, Firefighter (Entry
  Level), SFFD H-2. Skips lateral, engineer, captain, inspector, reserve, volunteer, seasonal, and
  paramedic-only titles ("Fire Recruit (EMT/Paramedic)" counts; "Firefighter Recruit - Paramedic"
  doesn't). Plain "Firefighter" or "Firefighter/EMT" stays skipped: those usually require a
  completed academy.

Alerts are labeled by category (push titles start with `EMT:` or `FF Recruit:`), and the dashboard
tags each job.

Postings can close fast (Sac City Fire's single-role EMT closed 14 minutes after opening at 250
applicants; AMR in about 45), so AMR/GMR, the fire agency pages and SF are checked every minute.
Falck and CalOpps rate-limit, and the site-wide GovernmentJobs search is only the backup net, so
those get every 5 minutes (`everyMinutes` in `src/config.ts`). A board that fails backs off from its
own pace (1, 2, 4… min; 5, 10, 20… for 5-minute boards, max 60) and returns to normal after one
success. D1 is only written when something changes, about 1,600 rows a day against the free tier's
100k.

Each job alerts **once**, the first time it's seen (tracked in D1). A job that disappears for 24h+
and comes back (a reposted recruitment) alerts again. The first run after deploying
emails everything currently open. If a board fails for 6+ hours (usually because the site changed),
you get one "scraper broken" alert. AMR and Sac City Fire always have listings, so if one
suddenly returns none, that counts as a failure too (a broken parser looks like an empty board). It
still gets checked every minute, since the board might really be empty.

### Announcement emails (the early warning)

Sac Fire emails its interest list _before_ a posting exists ("single-role EMT" or "Fire Recruit"
applications open 11/16 at 12:01 AM), sometimes months ahead. The scraper can't see a posting that isn't up yet, so
those emails go to **`announce@morgannstovold.com`**, which Cloudflare Email Routing hands to this Worker
(it's on morgannstovold.com because stovold.dev's mail is Google Workspace; see Setup):

1. The email is always forwarded to `NOTIFY_EMAIL` first (so you see "confirm your subscription"
   links, and nothing is lost if parsing fails).
2. If the sender is in `ANNOUNCERS` (`src/config.ts`), it's categorized like a job: the subject goes
   through the title filter, then the body counts only on strong phrases ("single-role", "EMS
   trainee", "Fire Service EMT" → EMT; "firefighter trainee/recruit", "fire recruit" → FF Recruit,
   with the same paramedic-only and lateral excludes). A body that merely says "EMT certification
   required" doesn't count. Matches are stored in D1 (`announcements`) with their category and the
   opening date/time if one is stated (read as Pacific time; a date with no time counts as midnight;
   dates after "through", "until", "closes", "deadline"… are closing dates and are ignored).
3. You get a push right away: "Sac City Fire: single-role EMT opening announced - opens Mon 11/16
   12:01 AM" (or "Fire Recruit opening announced", or "date not stated").
4. That agency's boards are checked immediately, in case the posting is already live.
5. A durable Cloudflare Workflow per announcement then pushes reminders at **24h, 3h and 10m
   before** opening (`REMINDERS_MIN` in `src/config.ts`). The ones within an hour of opening are
   priority 2 (repeat until acknowledged); the rest are priority 1. Reminders whose time had already
   passed when the email arrived are skipped. Then it waits for the posting. When the per-minute
   scraper finds a new job of the same category on that agency's board, it's alerted as **"OPEN NOW
   -"** at priority 2 and the announcement is marked confirmed. With no date stated it's watched for 270 days; otherwise
   until 30 days after opening.

Active announcements show at the top of the dashboard. To add another agency's list, add an entry to
`ANNOUNCERS` with its sender pattern and the `SOURCES` names to watch. `REMINDER_OFFSETS_MIN` in
`.env` overrides the reminder list (minutes before opening), e.g. `6,3,2,1` to test on an
announcement a few minutes out.

### Alert priority and delivery

Push priority depends on the job type (`PRIORITY` in `src/config.ts`), not the board:

- **911 EMT positions: 2 (emergency).** Repeats every 30s until you acknowledge it, from any board.
- **Firefighter trainee/recruit openings: 0 (normal).** A regular notification that respects your
  Pushover quiet hours: nice to know, not urgent.
- **Announcements:** an EMT announcement pushes at 1 (high, sounds through quiet hours) and its
  reminders go to 2 within an hour of opening. FF recruit announcements and their reminders stay at 0.

Alerts never go out directly. Each one (a push per job, so tapping opens its apply page, plus one
summary email) is a message on the `notify` Cloudflare Queue:

- **Push:** tried 3 times (now, +10s, +30s). If the third try fails, the same alert is **emailed
  right away**, so a broken Pushover costs you under a minute, not an hour of retries.
- **Email:** retried after 10s, 30s, 1m, 2m, 5m… (8 tries).
- A message that still fails lands on `notify-dlq`, which makes one last attempt as a push (the
  channel not being retried by then), then gives up and logs.

Queues deliver at least once, so each alert's dedupe key is recorded in D1 (`sent`) and repeats are
skipped.

## Setup

1. **Email.** In the Cloudflare dashboard (Email → Email Routing → **Destination addresses**), add the
   inbox you want alerts in and click the verification link Cloudflare emails you. Alerts are sent
   from `jobs@stovold.dev`. Sending is free.
   **Don't enable Email Routing on stovold.dev itself:** its mail (morgan@stovold.dev) is Google
   Workspace, and enabling routing there would replace its MX records. Inbound announcement mail uses
   morgannstovold.com instead, which has no other mail.
2. **Push (optional, the "SMS").** Install [Pushover](https://pushover.net) (iOS/Android, $5 one-time
   after a 30-day trial) and log in. Copy your **user key** from the Pushover dashboard, then create an
   application ("Create an Application/API Token") and copy its **API token**. Each alert links to the
   job's apply page, with a Dashboard link in the message. Alert priority is set per board (see above).
3. **Announcements.** Deploying enables Email Routing on morgannstovold.com (adds Cloudflare's MX/SPF
   records there) and creates the `announce@morgannstovold.com` → Worker rule (prod only).
   Sign up for Sac Fire's hiring alerts (on its
   [single-role EMT page](https://www.cityofsacramento.gov/fire/join-sacramento-fire/career-paths/ems-single-role))
   with `announce@morgannstovold.com`, then click the confirmation link in the forwarded email. When the
   first real announcement arrives, check its sender and tighten `from` in `ANNOUNCERS` if needed.
   Other agencies' lists need their own `ANNOUNCERS` entry once you know their sender.
   **Testing:** set `ANNOUNCE_TEST_FROM` in `.env` to your personal address and deploy. Mail from it
   is treated as a "Test" announcement (no boards linked, so it can't mark a real posting "OPEN NOW").
   Remove it when you're done.
4. Copy `.env.example` to `.env` and fill in `NOTIFY_EMAIL`, `PUSHOVER_USER`, `PUSHOVER_TOKEN`, and `ADMIN_KEY`.
5. Deploy:

   ```bash
   bun run deploy
   ```

6. Test: visit `https://jobs.stovold.dev/test?key=<ADMIN_KEY>` to send a test alert through the
   queue (add `&priority=2` to try an emergency push), or
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
