import { expect, test } from "bun:test";

import { classifyTitle } from "./filter.ts";
import { parseWfcaFeed } from "./sources.ts";

// Shaped like wfca.com/feed: en dashes as entities, news mixed with job posts, every state.
const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<item><title>CA &#8211; Single Role Emergency Medical Technician &#8211; Moraga-Orinda Fire District &#8211; Closing: 12/18/26</title>
<link>https://wfca.com/uncategorized/ca-single-role-emt-mofd/</link>
<pubDate>Sat, 21 Nov 2026 16:00:00 +0000</pubDate>
<guid isPermaLink="false">https://wfca.com/?p=101</guid></item>
<item><title>CA &#8211; Firefighter Trainee &#8211; Rodeo-Hercules Fire District &#8211; Continuous</title>
<link>https://wfca.com/uncategorized/ca-ff-trainee-rhfd/</link>
<pubDate>Fri, 20 Nov 2026 16:00:00 +0000</pubDate></item>
<item><title>CA &#8211; Fire Chief &#8211; Heartland Fire &amp; Rescue &#8211; Closing: 12/06/2026</title>
<link>https://wfca.com/uncategorized/ca-fire-chief-heartland/</link></item>
<item><title>OR &#8211; Firefighter/Paramedic &#8211; Lane Fire Authority &#8211; 12/02/2026</title>
<link>https://wfca.com/uncategorized/or-ff-lane/</link></item>
<item><title><![CDATA[Stop Reinventing the Fire Engine: The Case for Standardizing Apparatus]]></title>
<link>https://wfca.com/news/standardizing-apparatus/</link></item>
</channel></rss>`;

test("WFCA feed: nearby California job posts only, split into title / agency / detail", () => {
  const jobs = parseWfcaFeed(FEED, "WFCA");
  expect(jobs.map((j) => [j.title, j.employer, j.detail])).toEqual([
    ["Single Role Emergency Medical Technician", "Moraga-Orinda Fire District", "Closing: 12/18/26"],
    ["Firefighter Trainee", "Rodeo-Hercules Fire District", "Continuous"],
  ]);
  expect(jobs[0]).toMatchObject({
    id: "wfca:https://wfca.com/?p=101",
    url: "https://wfca.com/uncategorized/ca-single-role-emt-mofd/",
    postedAt: "2026-11-21T16:00:00.000Z",
  });
  // Falls back to the link when there's no plain <guid>; titles go through the normal filter.
  expect(jobs[1].id).toBe("wfca:https://wfca.com/uncategorized/ca-ff-trainee-rhfd/");
  expect(jobs.map((j) => classifyTitle(j.title))).toEqual(["emt", "ff"]);
});
