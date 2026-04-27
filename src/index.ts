import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import connectPg from "connect-pg-simple";
import routes from "./routes";
import { initDb, pool } from "./db";

process.on("uncaughtException", (err) => {
  console.error("[crash] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[crash] unhandledRejection:", reason);
  process.exit(1);
});

const PgStore = connectPg(session);

const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());

app.use(
  session({
    store: new PgStore({
      pool,
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET ?? "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // HTTPS only in prod
      maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
    },
  }),
);

app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path}`);
  next();
});

app.use(routes);

// Catches any error passed to next(err) from route handlers
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT ?? 3000;

// initDb runs CREATE TABLE IF NOT EXISTS — safe to run on every boot.
// We wait for it to finish before accepting any requests.
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\nServer running at http://localhost:${PORT}`);
      console.log(
        `Step 1: GET  http://localhost:${PORT}/auth/url  → open that URL in your browser`,
      );
      console.log(
        `Step 2: POST http://localhost:${PORT}/sync/start → start the sync`,
      );
      console.log(
        `        GET  http://localhost:${PORT}/sync/status → check progress\n`,
      );
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
