/**
 * Minimal OpenAPI 3.0 type stubs.
 *
 * We use `Record<string, unknown>` for spec sub-objects rather than pulling
 * in `openapi-types` — the spec file is hand-rolled and the runtime is just
 * `swagger-ui-express`, which accepts any plain object.
 */
export namespace OpenAPIV3 {
  export type Document = {
    openapi: string;
    info: Record<string, unknown>;
    servers?: Record<string, unknown>[];
    security?: Record<string, unknown>[];
    tags?: Record<string, unknown>[];
    paths: Record<string, unknown>;
    components?: Record<string, unknown>;
  };
}
