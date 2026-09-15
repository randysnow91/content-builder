import { Router } from "express";

// Stub for M0 — the real Research/Curator/Writer/Reviewer pipeline is built
// in M2-M5 (see docs/R2_BUILD-SPEC.md §8). This route exists now only to
// prove the auth gate and routing work end to end.
export const generateRouter = Router();

generateRouter.post("/generate", (_req, res) => {
  res.status(501).json({ error: "Not implemented yet — see docs/R2_BUILD-SPEC.md M2" });
});
