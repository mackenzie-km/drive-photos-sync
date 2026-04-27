"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const express_session_1 = __importDefault(require("express-session"));
const connect_pg_simple_1 = __importDefault(require("connect-pg-simple"));
const routes_1 = __importDefault(require("./routes"));
const db_1 = require("./db");
process.on("uncaughtException", (err) => {
    console.error("[crash] uncaughtException:", err);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error("[crash] unhandledRejection:", reason);
    process.exit(1);
});
const PgStore = (0, connect_pg_simple_1.default)(express_session_1.default);
const app = (0, express_1.default)();
app.set("trust proxy", 1);
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
    credentials: true,
}));
app.use(express_1.default.json());
app.use((0, express_session_1.default)({
    store: new PgStore({
        pool: db_1.pool,
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
}));
app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.path}`);
    next();
});
app.use(routes_1.default);
// Catches any error passed to next(err) from route handlers
app.use((err, req, res, _next) => {
    console.error(`[error] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: "Internal server error" });
});
const PORT = process.env.PORT ?? 3000;
// initDb runs CREATE TABLE IF NOT EXISTS — safe to run on every boot.
// We wait for it to finish before accepting any requests.
(0, db_1.initDb)()
    .then(() => {
    app.listen(PORT, () => {
        console.log(`\nServer running at http://localhost:${PORT}`);
        console.log(`Step 1: GET  http://localhost:${PORT}/auth/url  → open that URL in your browser`);
        console.log(`Step 2: POST http://localhost:${PORT}/sync/start → start the sync`);
        console.log(`        GET  http://localhost:${PORT}/sync/status → check progress\n`);
    });
})
    .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
});
