import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const DOMAIN = "jobs.stovold.dev";
/**
 * Inbound announcement mail lives on morgannstovold.com, which has no other mail. NOT stovold.dev: its
 * MX points at Google Workspace (morgan@stovold.dev), so mail sent there never reaches Cloudflare, and
 * enabling Cloudflare Email Routing there would replace those MX records and break that inbox.
 * (Outbound alerts still send fine from jobs@stovold.dev.)
 */
const ANNOUNCE_DOMAIN = "morgannstovold.com";
/** Inbound address for agency interest-list emails ("applications open 11/16 at 12:01 AM"). */
const ANNOUNCE_ADDRESS = `announce@${ANNOUNCE_DOMAIN}`;

/**
 * Every outbound alert goes through `notify` (retried with backoff); messages that exhaust their
 * retries land on `notify-dlq`, whose consumer makes one last attempt over the other channel.
 * Named per stage so the consumer can tell the two apart (`batch.queue`).
 */
const NotifyQueues = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  const queue = yield* Cloudflare.Queues.Queue("Notify", { name: `job-finder-notify-${stage}` });
  const dlq = yield* Cloudflare.Queues.Queue("NotifyDlq", { name: `job-finder-notify-dlq-${stage}` });
  return { queue, dlq };
});

export const Worker = Cloudflare.Worker(
  "JobWatch",
  Effect.gen(function* () {
    // Only prod claims the custom domain, so `bun run dev` / other stages don't fight over it.
    const isProd = (yield* Alchemy.Stage) === "prod";
    const { queue, dlq } = yield* NotifyQueues;
    return {
      main: "./src/index.ts",
      domain: isProd ? DOMAIN : undefined,
      // Every minute: postings can close within 15 minutes. Each board's own pace is in src/config.ts.
      crons: ["* * * * *"],
      env: {
        DB: Cloudflare.D1.Database("JobsDb", { migrations: "./migrations" }),
        NOTIFY: queue,
        NOTIFY_DLQ_NAME: dlq.queueName,
        // One durable instance per announcement email: reminders before it opens, then waits for the posting.
        ANNOUNCE_WF: Cloudflare.Workflow<{ announcementId: number }>("AnnouncementWorkflow", {
          className: "AnnouncementWorkflow",
        }),
        // Optional: one personal address allowed to send test announcements (see README).
        ANNOUNCE_TEST_FROM: Config.String("ANNOUNCE_TEST_FROM").pipe(Config.withDefault("")),
        // Optional override of REMINDERS_MIN (src/config.ts): minutes before opening, e.g. "1440,180,30,5".
        REMINDER_OFFSETS_MIN: Config.String("REMINDER_OFFSETS_MIN").pipe(Config.withDefault("")),
        // Cloudflare Email Routing send_email binding - free; the recipient must be a
        // verified destination address on the account.
        EMAIL: Cloudflare.Email.SendEmail("Email"),
        NOTIFY_EMAIL: Config.String("NOTIFY_EMAIL"),
        FROM_EMAIL: Config.String("FROM_EMAIL").pipe(Config.withDefault("jobs@stovold.dev")),
        // Optional Pushover push alerts: app API token + your user key. Leave empty to disable.
        PUSHOVER_TOKEN: Config.Redacted("PUSHOVER_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
        PUSHOVER_USER: Config.Redacted("PUSHOVER_USER").pipe(Config.withDefault(Redacted.make(""))),
        // Optional: enables /run?key=… and /test?key=…
        ADMIN_KEY: Config.String("ADMIN_KEY").pipe(Config.withDefault("")),
        // The worker's public URL - cron runs have no request to learn it from. Linked from push alerts.
        DASHBOARD_URL: isProd ? `https://${DOMAIN}` : "http://localhost:1337",
      },
    };
  }),
);

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "job-finder",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Worker;
    const { queue, dlq } = yield* NotifyQueues;
    yield* Cloudflare.Queues.Consumer("NotifyConsumer", {
      queueId: queue.queueId,
      scriptName: worker.workerName,
      deadLetterQueue: dlq.queueName,
      // ~8 retries with the consumer's own short backoff (10s, 30s, 1m, 2m, 5m…); deliver fast.
      settings: { batchSize: 10, maxWaitTimeMs: 1000, maxRetries: 8, retryDelay: 10 },
    });
    // Without a consumer, dead-lettered messages would expire unseen.
    yield* Cloudflare.Queues.Consumer("NotifyDlqConsumer", {
      queueId: dlq.queueId,
      scriptName: worker.workerName,
      settings: { batchSize: 10, maxWaitTimeMs: 1000, maxRetries: 2 },
    });
    if ((yield* Alchemy.Stage) === "prod") {
      // Cloudflare Email Routing on ANNOUNCE_DOMAIN so it can receive announce@. Adds Cloudflare's
      // MX/SPF records to morgannstovold.com (which had no mail records).
      yield* Cloudflare.Email.Routing("AnnounceRouting", { zone: ANNOUNCE_DOMAIN });
      // announce@morgannstovold.com -> this Worker's email() handler.
      yield* Cloudflare.Email.Rule("AnnounceRoute", {
        zone: ANNOUNCE_DOMAIN,
        name: "EMT Job Watch announcements",
        matchers: [{ type: "literal", field: "to", value: ANNOUNCE_ADDRESS }],
        actions: [{ type: "worker", value: [worker.workerName] }],
      });
    }
    return { url: worker.url };
  }),
);
