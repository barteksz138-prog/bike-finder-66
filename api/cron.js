import { Redis } from "@upstash/redis";
import { runScanCycle } from "../lib/scanner.js";

const redis = Redis.fromEnv();

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel Cron dodaje ten nagłówek automatycznie do zaplanowanych wywołań.
  const isVercelCron = req.headers["x-vercel-cron"] !== undefined;
  const authHeader = req.headers["authorization"] || "";
  const hasSecret = process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runScanCycle(redis);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

