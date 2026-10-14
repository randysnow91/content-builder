import "dotenv/config";
import express from "express";
import { requireConductorSecret } from "./lib/auth";
import { generateRouter } from "./routes/generate";

const app = express();
// Raised from Express's 100kb default: a weekly request carries a whole
// week of daily Issues in its body (docs/R2_BUILD-SPEC.md M5).
app.use(express.json({ limit: "2mb" }));

// No auth required — Render health checks and a quick "is it up" from the
// Conductor (docs/R2_BUILD-SPEC.md §6.1).
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(requireConductorSecret);
app.use(generateRouter);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Content Builder listening on port ${port}`);
});
