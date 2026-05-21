// Centralized error envelope. Zod errors -> 400 with field info; everything
// else is logged and returned as { error: { code, message } }.
import fp from "fastify-plugin";
import { ZodError } from "zod";

export default fp(async (app) => {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Request body failed validation",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.code(status).send({
      error: {
        code: (err as { code?: string }).code ?? (status >= 500 ? "internal_error" : "request_error"),
        message: err.message,
      },
    });
  });
});
