// Run every source locally and print what would match: `bun scripts/check.ts [--all]`
import { SOURCES } from "../src/config.ts";
import { categorize } from "../src/filter.ts";
import { fetchSource } from "../src/sources.ts";

const showAll = process.argv.includes("--all");

for (const src of SOURCES) {
  try {
    const jobs = await fetchSource(src);
    const matches = jobs.filter((j) => categorize(j));
    console.log(`\n## ${src.name}: ${jobs.length} fetched, ${matches.length} matches`);
    for (const j of showAll ? jobs : matches) {
      const tag = categorize(j)?.category ?? "  ";
      console.log(
        `  ${tag.padEnd(3)} ${j.title} - ${j.employer} - ${j.location} ${j.postedAt?.slice(0, 10) ?? ""}\n      ${j.url}`,
      );
    }
  } catch (e) {
    console.log(`\n## ${src.name}: ERROR ${(e as Error).message}`);
  }
}
