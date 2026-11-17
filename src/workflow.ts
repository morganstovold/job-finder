import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { WorkerEnv } from "../alchemy.run.ts";
import { watchAnnouncement, type Step } from "./announce-watch.ts";

/**
 * One instance per announcement email (id `ann-<row id>`). Durable: its sleeps survive deploys and
 * restarts for months, so reminders need no polling in the cron. The steps live in announce-watch.ts.
 */
export class AnnouncementWorkflow extends WorkflowEntrypoint<WorkerEnv, { announcementId: number }> {
  async run(event: Readonly<WorkflowEvent<{ announcementId: number }>>, step: WorkflowStep) {
    return watchAnnouncement(this.env, event.payload.announcementId, step as unknown as Step);
  }
}
