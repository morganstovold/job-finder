import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const DOMAIN = "jobs.stovold.dev";

export const Worker = Cloudflare.Worker(
  "JobWatch",
  Effect.gen(function* () {
    // Only prod claims the custom domain, so `bun run dev` / other stages don't fight over it.
    const isProd = (yield* Alchemy.Stage) === "prod";
    return {
      main: "./src/worker.ts",
      domain: isProd ? DOMAIN : undefined,
      // Every 10 minutes - ~15 small requests per run across all boards.
      crons: ["*/10 * * * *"],
      env: {
        DB: Cloudflare.D1.Database("JobsDb", { migrations: "./migrations" }),
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
    return { url: worker.url };
  }),
);
