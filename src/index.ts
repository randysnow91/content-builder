import "dotenv/config";
import express from "express";
import { requireConductorSecret } from "./lib/auth";
import { generateRouter } from "./routes/generate";

const app = express();
app.use(express.json());

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
