import type { NextFunction, Request, Response } from "express";

// Mirrors EmailServer's src/lib/adminAuth.ts constantTimeEqual: a plain
// `===` short-circuits on the first wrong character and leaks, via timing,
// how much of a guess was right.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Gates every route except /health (see docs/R2_BUILD-SPEC.md §4.1) — the
// Conductor is the one legitimate caller and holds this same secret.
export function requireConductorSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.CONDUCTOR_ACCESS_SECRET;
  if (!expected) {
    res.status(500).json({ error: "Server misconfigured: CONDUCTOR_ACCESS_SECRET not set" });
    return;
  }

  const provided = req.header("x-conductor-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
