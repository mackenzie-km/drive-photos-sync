// Vercel serverless function for /auth/callback.
//
// Vercel's rewrite proxy strips Set-Cookie headers from upstream responses,
// so we can't use a rewrite for this route. Instead, this function proxies
// the request to the Render backend and explicitly forwards Set-Cookie so
// the session cookie is set on this domain (sync.mackenziekg.dev).

export default async function handler(req, res) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") params.set(key, value);
  }

  const backendRes = await fetch(
    `${process.env.BACKEND_URL}/auth/callback?${params}`,
    { redirect: "manual" },
  );

  const cookies =
    backendRes.headers.getSetCookie?.() ??
    (backendRes.headers.get("set-cookie")
      ? [backendRes.headers.get("set-cookie")]
      : []);
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);

  // Render responds with either a 302 redirect or a 200 with a client-side redirect script.
  const location = backendRes.headers.get("location");
  if (location) {
    res.redirect(location);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.send(await backendRes.text());
  }
}
