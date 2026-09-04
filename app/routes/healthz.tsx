import prisma from "../db.server";
import { logger } from "../lib/logger.server";

/**
 * Health check for the platform load balancer and uptime monitoring.
 *
 * Reports liveness plus a real database round-trip, because an app that
 * responds but cannot reach Postgres is not healthy. Deliberately exposes no
 * configuration, versions, or connection details — a health endpoint is
 * unauthenticated and must not be a reconnaissance tool.
 */
export const loader = async () => {
  const checks: Record<string, "ok" | "fail"> = { app: "ok", database: "fail" };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (error) {
    logger.error({ err: error }, "Health check: database unreachable");
  }

  const healthy = Object.values(checks).every((status) => status === "ok");

  return new Response(JSON.stringify({ status: healthy ? "ok" : "degraded", checks }), {
    status: healthy ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};
