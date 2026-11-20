import nextEnv from '@next/env';

// Los comandos de preparación deben abrir la misma base que el servidor de Next.
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
