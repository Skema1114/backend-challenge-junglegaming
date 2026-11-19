import { MikroORM } from "@mikro-orm/postgresql";
import { buildMikroOrmConfig } from "../../../mikro-orm.config";

async function main() {
  const action = process.argv[2] ?? "up";
  const orm = await MikroORM.init(buildMikroOrmConfig());
  try {
    const migrator = orm.getMigrator();
    if (action === "up") {
      const executed = await migrator.up();
      console.log(`Migrations UP applied: ${executed.map((m) => m.name).join(", ") || "none"}`);
    } else if (action === "down") {
      const reverted = await migrator.down();
      console.log(`Migrations DOWN reverted: ${reverted.map((m) => m.name).join(", ") || "none"}`);
    } else {
      throw new Error(`Unsupported migration action: ${action}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
