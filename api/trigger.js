import { Redis } from "@upstash/redis";
import { runScanCycle } from "../lib/scanner.js";

const redis = Redis.fromEnv();

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { password } = req.body || {};
  if (!process.env.MANUAL_TRIGGER_SECRET || password !== process.env.MANUAL_TRIGGER_SECRET) {
    return res.status(401).json({ error: "Złe hasło" });
  }

  try {
    const result = await runScanCycle(redis);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
