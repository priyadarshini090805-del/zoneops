// GET /v1/stream/live — Server-Sent Events for live map updates.
//
// Why SSE not WebSockets:
// - One-way (server -> client) is all we need for MVP.
// - Works through every HTTP proxy and load balancer without special config.
// - Plays nicely with HTTP/2.
//
// Each client opens one EventSource. We subscribe to a per-org Redis Pub/Sub
// channel and forward messages. The worker publishes location_update and
// fence_event messages onto that channel.
import type { FastifyPluginAsync } from "fastify";
import { Redis } from "ioredis";
import { liveChannel } from "@zoneops/types";

const stream: FastifyPluginAsync = async (app) => {
  app.get("/live", async (req, reply) => {
    const auth = await app.requireAuth(req);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

    // Each SSE connection needs its own subscriber; ioredis can't multiplex
    // subscribe with regular commands on a shared client.
    const sub = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 3 });
    const channel = liveChannel(auth.orgId);
    await sub.subscribe(channel);
    sub.on("message", (_chan: string, message: string) => {
      reply.raw.write(`data: ${message}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 20_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      sub.disconnect();
    });
  });
};

export default stream;
