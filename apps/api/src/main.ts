import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { loadConfig } from "./config";

const config = loadConfig();
const app = await NestFactory.create(AppModule.register(config), { logger: ["error", "warn", "log"] });
configureApp(app);
app.enableShutdownHooks();
app.getHttpAdapter().getInstance().set("trust proxy", false);
await app.listen(config.port);
console.log(`shelfline api on :${config.port}`);
