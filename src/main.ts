import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { types } from "pg";
import { AppModule, ObserveInstrument } from "./app.module.js";
import { ErrorFilter } from "./common/error.filter.js";
import type {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
types.setTypeParser(1082, (value) => value);
export async function createApp() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const app = await NestFactory.create(
    AppModule,
    process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET
      ? { instrument: ObserveInstrument }
      : {},
  );
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1");
  app.use((helmet as unknown as () => RequestHandler)());
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.FRONTEND_ORIGINS || "http://localhost:3000").split(
      ",",
    ),
    credentials: true,
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Request-Id", randomUUID());
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.useGlobalFilters(new ErrorFilter());
  const config = new DocumentBuilder()
    .setTitle("HouseLedger Admin API")
    .setVersion("1")
    .addCookieAuth("hl_session")
    .build();
  SwaggerModule.setup(
    "api/docs",
    app,
    SwaggerModule.createDocument(app, config),
  );
  return app;
}
if (process.env.NODE_ENV !== "test") {
  const app = await createApp();
  await app.listen(Number(process.env.PORT || 4000), "0.0.0.0");
}
