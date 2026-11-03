import { buildGateway } from './server.js';

const { app, config } = await buildGateway();
await app.listen({ host: config.host, port: config.port });
console.log(`ModelForge gateway listening on http://${config.host}:${config.port}`);
console.log(`  OpenAI-compatible API: http://${config.host}:${config.port}/v1`);
console.log(`  Admin API:             http://${config.host}:${config.port}/api`);
console.log(`  Dashboard (if built):  http://${config.host}:${config.port}/ui/`);
