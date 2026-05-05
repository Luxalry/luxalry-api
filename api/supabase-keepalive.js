export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase environment variables"
      });
    }

    // Prevent Vercel Caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/?select=*&t=${Date.now()}`, // Add timestamp to bypass upstream cache
      {
        method: "GET",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    return res.status(200).json({
      ok: true,
      status: response.status,
      message: "Supabase keep-alive ping sent",
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
