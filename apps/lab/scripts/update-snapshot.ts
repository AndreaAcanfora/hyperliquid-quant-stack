// Refresh data/daily-snapshot.json, the fallback served when Hyperliquid is
// unreachable. The live Lab does not need this: /api/daily refreshes itself.
//   pnpm --filter lab update-snapshot
import { writeFileSync } from "node:fs";
import { fetchDailyData } from "../lib/daily-data.ts";

const data = await fetchDailyData();
writeFileSync(new URL("../data/daily-snapshot.json", import.meta.url), JSON.stringify(data));
console.log(`daily-snapshot.json: ${data.days.length} days, last ${new Date(data.days.at(-1)!).toISOString().slice(0, 10)}`);
