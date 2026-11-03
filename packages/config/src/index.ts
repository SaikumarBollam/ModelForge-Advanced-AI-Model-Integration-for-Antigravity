import { z } from 'zod';

/**
 * Central runtime configuration, validated with Zod at startup.
 * Invalid configuration fails fast with a readable error — never silently.
 * (Zod is a gateway dependency; this package re-declares the schema shape
 * used across apps so config parsing is identical everywhere.)
 */

export const AppConfigSchema = z.object({
  dataDir: z.string().min(1),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  masterKey: z.string().min(16).optional(),
  gatewayApiKey: z.string().min(8).optional(),
  adminApiKey: z.string().min(8).optional(),
  allowPrivateUpstreams: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppConfigSchema.safeParse({
    dataDir: env.MODELFORGE_DATA_DIR ?? './data',
    host: env.MODELFORGE_HOST ?? '127.0.0.1',
    port: env.MODELFORGE_PORT ? Number(env.MODELFORGE_PORT) : 8787,
    masterKey: env.MODELFORGE_MASTER_KEY || undefined,
    gatewayApiKey: env.MODELFORGE_GATEWAY_API_KEY || undefined,
    adminApiKey: env.MODELFORGE_ADMIN_API_KEY || undefined,
    allowPrivateUpstreams: env.MODELFORGE_ALLOW_PRIVATE_UPSTREAMS !== 'false',
    logLevel: env.MODELFORGE_LOG_LEVEL ?? 'info',
  });
  if (!parsed.success) {
    throw new Error(`Invalid ModelForge configuration:\n${parsed.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}
