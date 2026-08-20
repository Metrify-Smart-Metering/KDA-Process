import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";
import { getSupabasePublishableKey, getSupabaseSecretKey, getSupabaseUrl } from "./env.ts";

/**
 * Constant-time comparison. Both sides are hashed first so the loop always
 * runs over 32 bytes and the timing leaks neither length nor content.
 */
export async function secretsEqual(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();

  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  const receivedBytes = new Uint8Array(receivedHash);
  const expectedBytes = new Uint8Array(expectedHash);

  let difference = 0;
  for (let i = 0; i < receivedBytes.length; i++) {
    difference |= receivedBytes[i] ^ expectedBytes[i];
  }

  return difference === 0;
}

/**
 * Authorizes a service-to-service call against the project's secret key.
 *
 * The platform does not verify the `apikey` header for the new key format, so
 * functions running with `verify_jwt = false` have to do it themselves.
 * Callers must send the secret key on `apikey` — never on `Authorization`,
 * which is reserved for user JWTs.
 *
 * Returns `null` when authorized, otherwise the `Response` to return.
 */
export async function requireSecretApiKey(
  req: Request,
  corsHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const unauthorized = new Response(
    JSON.stringify({ success: false, error: "Unauthorized" }),
    { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );

  const provided = req.headers.get("apikey");
  if (!provided) return unauthorized;

  let expected: string;
  try {
    expected = getSupabaseSecretKey();
  } catch (error) {
    console.error(
      "[Auth] Supabase Secret Key configuration is invalid:",
      error instanceof Error ? error.message : String(error),
    );

    return new Response(
      JSON.stringify({ success: false, error: "Server configuration error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return (await secretsEqual(provided, expected)) ? null : unauthorized;
}

/**
 * Authorizes an end-user (logged-in reviewer) call via user JWT.
 *
 * Same contract as `submit_reviewed_values`: the user JWT must be sent on
 * `Authorization: Bearer`, never an API key. The token is verified against
 * Supabase Auth (not just checked for presence). On success returns the user;
 * otherwise returns the `Response` to send back.
 */
export async function requireUser(
  req: Request,
  corsHeaders: Record<string, string> = {},
): Promise<{ user: { id: string; email?: string }; error: null } | { user: null; error: Response }> {
  const unauthorized = (message: string) =>
    new Response(JSON.stringify({ success: false, error: message }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return { user: null, error: unauthorized("Nicht eingeloggt.") };
  }

  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (bearerToken.startsWith("sb_publishable_") || bearerToken.startsWith("sb_secret_")) {
    return {
      user: null,
      error: unauthorized("Authorization muss ein Nutzer-Token enthalten, keinen API Key."),
    };
  }

  const supabase = createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null, error: unauthorized("Ungueltiges oder abgelaufenes Nutzer-Token.") };
  }

  return { user: { id: user.id, email: user.email ?? undefined }, error: null };
}
