import { createHash, timingSafeEqual } from "node:crypto";

// EXECUTIVE_AUTH_HASH is provisioned as a secret Netlify runtime variable.
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return jsonResponse(200, { ok: true });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const storedHash = Netlify.env.get("EXECUTIVE_AUTH_HASH") || "";
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) {
    console.error("Executive auth configuration incomplete: EXECUTIVE_AUTH_HASH missing or invalid");
    return jsonResponse(500, { error: "Authentication service configuration incomplete" });
  }

  const password = req.headers.get("x-dashboard-password") || "";
  if (!password) return jsonResponse(401, { error: "Unauthorized" });

  const suppliedDigest = createHash("sha256").update(password, "utf8").digest();
  const expectedDigest = Buffer.from(storedHash, "hex");
  const valid = suppliedDigest.length === expectedDigest.length && timingSafeEqual(suppliedDigest, expectedDigest);

  if (!valid) return jsonResponse(401, { error: "Unauthorized" });
  return jsonResponse(200, { ok: true, authenticated: true });
};
