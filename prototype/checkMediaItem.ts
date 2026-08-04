import "dotenv/config";
import { getAuthClient } from "../src/auth";

const USER_ID = "102316373971929260712";
const MEDIA_ID =
  "AA4XFhJzzg8EkXVBvt5kzJVGmbGgtycznqsn4CW-TObLJFxwZoaKExV8JQwVNeD_WPGJaVmYofKLGknU_tv6FqAxUL1B46Bu9Q";

async function main() {
  const auth = await getAuthClient(USER_ID);
  const token = await auth.getAccessToken();
  const res = await fetch(`https://photoslibrary.googleapis.com/v1/mediaItems/${MEDIA_ID}`, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  console.log("status:", res.status);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
