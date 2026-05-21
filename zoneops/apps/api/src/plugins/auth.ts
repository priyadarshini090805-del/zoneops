// Bearer auth. MVP-grade: an env-configured token -> org_slug map.
// Resolves to a real org_id from the DB on first use and caches it in-memory.
// Replace with proper user sessions + API keys in Phase 0.5.
import fp from "fastify-plugin";
import { sql } from "drizzle-orm";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: import("fastify").FastifyRequest) => Promise<{ orgId: string; orgSlug: string }>;
  }
  interface FastifyRequest {
    auth?: { orgId: string; orgSlug: string };
  }
}

export default fp<{ tokens: Map<string, string> }>(async (app, opts) => {
  const slugToOrgId = new Map<string, string>(); // memoized after first lookup

  async function resolveOrgId(slug: string): Promise<string | null> {
    if (slugToOrgId.has(slug)) return slugToOrgId.get(slug)!;
    const result = await app.db.db.execute<{ id: string }>(
      sql`SELECT id FROM orgs WHERE slug = ${slug} LIMIT 1`,
    );
    const id = (result as unknown as { rows: { id: string }[] }).rows[0]?.id;
    if (!id) return null;
    slugToOrgId.set(slug, id);
    return id;
  }

  app.decorate("requireAuth", async (req) => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) throw app.httpErrors.unauthorized("missing bearer token");
    const token = match[1]!.trim();
    const slug = opts.tokens.get(token);
    if (!slug) throw app.httpErrors.unauthorized("invalid bearer token");
    const orgId = await resolveOrgId(slug);
    if (!orgId) throw app.httpErrors.unauthorized(`token maps to unknown org "${slug}"`);
    req.auth = { orgId, orgSlug: slug };
    return req.auth;
  });
});
