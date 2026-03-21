import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import routes from "./routes";

const app = express();
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());

app.use(
  session({
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

app.use(routes);

const PORT = process.env.PORT ?? 3000;
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
