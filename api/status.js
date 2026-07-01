import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).end();

  try {
    const [lastRunRaw, logsRaw, resultsRaw, seenCount] = await Promise.all([
      redis.get("ddf:last_run"),
      redis.lrange("ddf:logs", 0, 199),
      redis.lrange("ddf:results", 0, 99),
      redis.scard("ddf:seen"),
    ]);

    const parseEach = (arr) =>
      (arr || [])
        .map((s) => {
          try {
            return typeof s === "string" ? JSON.parse(s) : s;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

    const lastRun =
      typeof lastRunRaw === "string" ? (() => { try { return JSON.parse(lastRunRaw); } catch { return null; } })() : lastRunRaw;

    res.status(200).json({
      lastRun: lastRun || null,
      logs: parseEach(logsRaw),
      results: parseEach(resultsRaw),
      seenCount: seenCount || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
