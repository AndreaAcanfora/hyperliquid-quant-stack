import snapshot from "@/data/daily-snapshot.json";
import { fetchDailyData } from "@/lib/daily-data";
import type { DailyData } from "@/lib/lab";

// Regenerated at most once an hour, so a new daily close shows up within
// an hour of 00:00 UTC without a redeploy. While a regeneration is in
// flight (or fails), the previous response keeps being served.
export const revalidate = 3600;

export async function GET() {
  let data: DailyData;
  try {
    data = await fetchDailyData();
  } catch (err) {
    // Hyperliquid unreachable: the committed snapshot keeps the Lab working.
    console.warn(`daily data: serving the snapshot (${err instanceof Error ? err.message : String(err)})`);
    data = snapshot as DailyData;
  }
  return Response.json(data);
}
