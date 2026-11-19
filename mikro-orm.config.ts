import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { ALL_ENTITY_SCHEMAS } from "./src/infrastructure/persistence/entities/schemas";
import { Migration202611190001_InitialSchema } from "./src/infrastructure/persistence/migrations/Migration202611190001_InitialSchema";

export function buildMikroOrmConfig(overrides: Partial<{ dbName: string; host: string; port: number }> = {}) {
  return defineConfig({
    host: overrides.host ?? process.env.DB_HOST ?? "localhost",
    port: overrides.port ?? Number(process.env.DB_PORT ?? 5439),
    dbName: overrides.dbName ?? process.env.DB_NAME ?? "wagering",
    user: process.env.DB_USER ?? "wagering",
    password: process.env.DB_PASSWORD ?? "wagering_secret",
    entities: ALL_ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      migrationsList: [
        {
          name: "Migration202611190001_InitialSchema",
          class: Migration202611190001_InitialSchema,
        },
      ],
    },
    pool: {
      min: 2,
      max: 20,
    },
  });
}

export default buildMikroOrmConfig();
