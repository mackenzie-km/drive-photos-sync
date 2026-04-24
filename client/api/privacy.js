const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy Policy — Tag and Sync</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        max-width: 640px;
        margin: 60px auto;
        padding: 0 24px;
        color: #141414;
        line-height: 1.7;
      }
      h1 { font-size: 28px; margin-bottom: 4px; }
      h2 { font-size: 18px; margin-top: 36px; margin-bottom: 4px; }
      p  { margin: 12px 0; }
      ul { margin: 12px 0; padding-left: 24px; }
      li { margin: 6px 0; }
      a  { color: #4f46e5; }
      .updated { color: #666; font-size: 14px; margin-bottom: 32px; }
    </style>
  </head>
  <body>
    <h1>Tag and Sync — Privacy Policy</h1>
    <p class="updated">Last updated: April 24, 2026</p>

    <h2>What is Tag and Sync?</h2>
    <p>
      Tag and Sync is a web application that syncs photos from a folder in your
      Google Drive to Google Photos. You choose the folder using the Google Drive
      Picker. Optionally, it uses Google Gemini to generate search-friendly
      descriptions for your photos.
    </p>

    <h2>What data we access</h2>
    <p>To operate the service, Tag and Sync requests access to:</p>
    <ul>
      <li>Your <strong>Google Drive</strong> — specifically the folder you select via the Google Drive Picker, to read photo files stored there</li>
      <li>Your <strong>Google Photos</strong> — to upload those photos on your behalf</li>
      <li>Your <strong>Google account identity</strong> — to associate your data with your account</li>
    </ul>

    <h2>What data we store</h2>
    <p>Tag and Sync stores only what is necessary to perform the sync:</p>
    <ul>
      <li>
        <strong>OAuth tokens</strong> — your Google access and refresh tokens,
        stored securely in a database. These allow the app to access Drive and
        Photos on your behalf without requiring you to log in repeatedly.
      </li>
      <li>
        <strong>File metadata</strong> — the name, size, type, and checksum of
        each Drive file, along with its sync status and timestamps. Photo
        content is never stored on our servers; it is streamed directly from
        Drive to Photos.
      </li>
      <li>
        <strong>Sync history</strong> — counts of uploaded, skipped, and failed
        files per sync run, and when each run occurred.
      </li>
    </ul>

    <h2>Google Gemini (optional AI descriptions)</h2>
    <p>
      If you enable AI descriptions, individual photos are sent to the Google
      Gemini API to generate a text description. This is opt-in and can be
      disabled at any time from the main page. We do not store the generated
      descriptions beyond what Google Photos retains as part of the upload.
    </p>

    <h2>How we protect your data</h2>
    <p>OAuth tokens are sensitive data and are treated accordingly — encrypted in transit, encrypted at rest, and never logged or exposed in source code.</p>
    <p>We take the following steps to protect sensitive data:</p>
    <ul>
      <li>
        <strong>Encryption in transit</strong> — all communication between your
        browser, our servers, and Google APIs uses HTTPS/TLS. OAuth tokens are
        never transmitted over unencrypted connections.
      </li>
      <li>
        <strong>Encryption at rest</strong> — OAuth tokens and session data are
        stored in a managed PostgreSQL database (Neon) with encryption at rest
        enabled by default on all plans.
      </li>
      <li>
        <strong>Access controls</strong> — the database requires authenticated,
        TLS-encrypted connections. Database credentials are stored as environment
        variables and never exposed in source code or logs.
      </li>
      <li>
        <strong>Minimal scope</strong> — we request only the Drive, Photos, and
        identity scopes required for the sync to function. We use
        <code>drive.file</code>, which restricts access to only the specific
        folder you select via the Google Drive Picker — the app cannot read
        any other files in your Drive. The Google Drive Picker is a
        Google-hosted interface — our servers never receive or process your
        Drive file listing. We only receive the folder ID you explicitly select.
      </li>
      <li>
        <strong>Session security</strong> — session cookies are marked
        <code>HttpOnly</code> (not accessible to JavaScript) and
        <code>Secure</code> (HTTPS only) in production, with a 7-day expiry.
      </li>
    </ul>

    <h2>What we do not do</h2>
    <ul>
      <li>We do not sell or share your data with third parties.</li>
      <li>We do not store the contents of your photos on our servers.</li>
      <li>We do not use your data for advertising or profiling.</li>
    </ul>

    <h2>Third-party services</h2>
    <p>Tag and Sync uses the following Google services, each governed by Google's own privacy policy:</p>
    <ul>
      <li>Google Identity / OAuth 2.0 (sign-in and authorization)</li>
      <li>Google Drive API and Google Drive Picker</li>
      <li>Google Photos Library API</li>
      <li>Google Gemini API (optional)</li>
    </ul>

    <h2>Data retention</h2>
    <p>
      Your OAuth tokens and file metadata are retained for as long as you use
      the service. If you revoke access via Google Account permissions, your
      tokens become invalid. To request deletion of all data associated with
      your account, email us at
      <a href="mailto:mackenzie.gonzales.k@gmail.com">mackenzie.gonzales.k@gmail.com</a>
      and we will remove it within 30 days.
    </p>

    <h2>Your rights</h2>
    <ul>
      <li><strong>Access</strong> — you can request a copy of the data we hold about you.</li>
      <li><strong>Deletion</strong> — you can request that we delete your data at any time.</li>
      <li><strong>Portability</strong> — your photos remain in your own Google Drive and Google Photos; we do not hold copies.</li>
    </ul>
    <p>To exercise any of these rights, email <a href="mailto:mackenzie.gonzales.k@gmail.com">mackenzie.gonzales.k@gmail.com</a>.</p>

    <h2>Revoking access</h2>
    <p>
      You can revoke Tag and Sync's access to your Google account at any time via
      <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
        Google Account permissions
      </a>.
      Revoking access will prevent future syncs but will not delete data already
      synced to Google Photos.
    </p>

    <h2>Contact</h2>
    <p>
      Questions or concerns? Email us at
      <a href="mailto:mackenzie.gonzales.k@gmail.com">mackenzie.gonzales.k@gmail.com</a>.
    </p>
  </body>
</html>`;

export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(html);
}
